import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { activateSafariAutomation, assertSafariAutomationAvailable, inspectSafariAutomationProcess, startSafariDriver, stopSafariAutomationProcess, stopSafariDriver, verifySafariFiberResult } from './safari-webdriver.mjs'

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function webContentProcesses() {
  const result = spawnSync('/bin/ps', ['ax', '-o', 'pid=,rss=,comm='], { encoding: 'utf8' })
  if (result.status !== 0) throw Error(`Could not inspect WebContent processes: ${result.stderr}`)
  return result.stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match || !match[3].includes('/com.apple.WebKit.WebContent')) return []
    return [{ pid: Number(match[1]), residentKiB: Number(match[2]) }]
  })
}

const errorEvidence = error => ({
  name: String(error?.name ?? 'Error'),
  message: String(error?.message ?? error),
  code: error?.code == null ? null : String(error.code),
  stack: error?.stack == null ? null : String(error.stack),
})

async function capturePreCleanupEvidence({driver, driverProcess, safariPID}) {
  const evidence = {
    at: new Date().toISOString(),
    sessionId: driver?.sessionId ?? null,
    driverProcess: driverProcess ? { pid: driverProcess.pid, exitCode: driverProcess.exitCode, signalCode: driverProcess.signalCode } : null,
    safariProcess: null,
    safariProcessInspectionFailure: null,
    webContentProcesses: null,
    webContentInspectionFailure: null,
    windowHandle: null,
    windowHandles: null,
    windowInspectionFailure: null,
  }
  if (safariPID) {
    try { evidence.safariProcess = inspectSafariAutomationProcess(safariPID) }
    catch (error) { evidence.safariProcessInspectionFailure = errorEvidence(error) }
  }
  try { evidence.webContentProcesses = webContentProcesses() }
  catch (error) { evidence.webContentInspectionFailure = errorEvidence(error) }
  if (driver?.sessionId) {
    try {
      evidence.windowHandle = await driver.windowHandle()
      evidence.windowHandles = await driver.windowHandles()
    } catch (error) {
      evidence.windowInspectionFailure = errorEvidence(error)
    }
  }
  return evidence
}

async function startServer(sdkRoot) {
  const root = `${sdkRoot}/runtime/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage`
  const assets = Object.fromEntries(['core.mjs', 'engine.mjs', 'ffi.mjs', 'engine.wasm'].map(name => [name, readFileSync(`${root}/${name}`)]))
  const server = createServer((request, response) => {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    }
    const name = request.url?.slice(1)
    if (name && assets[name]) {
      response.writeHead(200, { ...headers, 'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' })
      response.end(assets[name])
      return
    }
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Safari fiber workload memory probe</title><script type="module">
      import * as core from '/core.mjs'
      import factory from '/engine.mjs'
      import {QuickJSAsyncFFI} from '/ffi.mjs'
      const state = globalThis.__fiberProbe = {status: 'starting', completed: 0, error: null, startedAt: performance.now()}
      try {
        const bytes = await (await fetch('/engine.wasm', {cache: 'no-store'})).arrayBuffer()
        const engine = await core.newQuickJSAsyncWASMModuleFromVariant({type: 'async', importFFI: async () => QuickJSAsyncFFI, importModuleLoader: async () => async () => factory({wasmBinary: bytes})})
        engine.configureSharedStorage(1280 * 1024 * 1024, true)
        state.status = 'running'
        for (let index = 0; index < Number(new URL(location.href).searchParams.get('cycles')); index++) {
          const runtime = engine.newRuntime()
          runtime.setMemoryLimit(64 * 1024 * 1024)
          runtime.setMaxStackSize(256 * 1024)
          const context = runtime.newContext()
          let fiber
          try {
            const fn = context.unwrapResult(context.evalCode('() => { let total = 0; for (let i = 0; i < 5000000; i++) total = (total + (i % 97)) % 1000000007; return total }'))
            try { fiber = context.startFiberCall(fn) } finally { fn.dispose() }
            let steps = 0
            let yields = 0
            for (;;) {
              if (++steps > 10000) throw Error('Fiber step ceiling exceeded')
              const status = fiber.step()
              if (status === 2) break
              if (status !== 3) throw Error('Unexpected fiber status: ' + status)
              yields++
              if (fiber.deliver(0)) throw Error('Fairness suspension unexpectedly required a value')
              await new Promise(resolve => setTimeout(resolve, 0))
            }
            const result = fiber.takeResult()
            try {
              const value = context.unwrapResult(result)
              state.last = {steps, yields, value: context.dump(value)}
              if (state.last.value !== 239998879) throw Error('Incorrect fiber arithmetic result: ' + state.last.value)
            } finally { result.dispose() }
          } finally {
            fiber?.dispose()
            context.dispose()
            runtime.dispose()
          }
          state.completed = index + 1
          await new Promise(resolve => setTimeout(resolve, 0))
        }
        state.durationMs = performance.now() - state.startedAt
        state.status = 'passed'
      } catch (error) {
        state.status = 'failed'
        state.error = String(error)
        state.stack = error?.stack
      }
    </script>`)
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return {
    assets,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  }
}

const sdkRoot = resolve(process.env.SDK_OUTPUT ?? '')
if (!process.env.SDK_OUTPUT) throw Error('Set SDK_OUTPUT to the exact packaged SDK directory')
const output = resolve(process.env.SAFARI_FIBER_REPORT ?? 'reports/safari-fiber-workload-memory.json')
const cycles = Number(process.env.SAFARI_FIBER_CYCLES ?? 8)
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 20) throw Error('SAFARI_FIBER_CYCLES must be from 1 through 20')
const host = await startServer(sdkRoot)
let driverProcess
let driver
const report = {
  format: 1,
  startedAt: new Date().toISOString(),
  sdkRoot,
  browserVersion: null,
  safariPID: null,
  ownership: null,
  cycles,
  sharedStorage: { maxBytes: 1280 * 1024 * 1024, growthReservation: true },
  assets: Object.fromEntries(Object.entries(host.assets).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])),
  samples: [],
}
try {
  assertSafariAutomationAvailable()
  const started = await startSafariDriver({})
  driverProcess = started.child
  driver = started.driver
  const capabilities = await driver.createSession()
  report.browserVersion = capabilities.browserVersion ?? capabilities.version ?? null
  await driver.maximizeWindow()
  report.safariPID = (await activateSafariAutomation()).pid
  // Establish a document before asking SafariDriver for window handles.
  // This page performs no guest work and is outside the workload deadline.
  await driver.navigate('data:text/html,<title>Safari fiber probe initialization</title>')
  report.ownership = {
    driverPID: driverProcess.pid,
    safariPID: report.safariPID,
    sessionId: driver.sessionId,
    windowHandle: await driver.windowHandle(),
    windowHandles: await driver.windowHandles(),
  }
  await driver.navigate(`${host.origin}/?cycles=${cycles}`)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const state = await driver.execute('const s=globalThis.__fiberProbe; return s && {status:s.status,completed:s.completed,failure:s.error,stack:s.stack,durationMs:s.durationMs,last:s.last}')
    report.samples.push({ at: new Date().toISOString(), state, processes: webContentProcesses() })
    if (state?.status === 'passed' || state?.status === 'failed') break
    await wait(1_000)
  }
  report.result = report.samples.at(-1)?.state
  if (!report.result || !['passed', 'failed'].includes(report.result.status)) report.result = { status: 'timeout' }
  await wait(10_000)
  report.afterSettleProcesses = webContentProcesses()
  verifySafariFiberResult(report.result,cycles)
} catch (error) {
  report.failure = errorEvidence(error)
  report.preCleanup = await capturePreCleanupEvidence({ driver, driverProcess, safariPID: report.safariPID })
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  await driver?.close()
  await stopSafariDriver(driverProcess)
  if (report.safariPID) await stopSafariAutomationProcess(report.safariPID)
  await host.close()
}
console.log(output)
