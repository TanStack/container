import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { activateSafariAutomation, assertSafariAutomationAvailable, startSafariDriver, stopSafariAutomationProcess, stopSafariDriver } from './safari-webdriver.mjs'

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

function realisticTSX() {
  const lines = ["import React from 'react'", "import { createFileRoute } from '@tanstack/react-router'"]
  for (let index = 0; index < 600; index++) {
    lines.push(`export const value${index}: number = ${index}`)
    lines.push(`export function Item${index}(props: {label: string}) { return <div data-index={${index}}>{props.label}{value${index}}</div> }`)
  }
  lines.push("export const Route = createFileRoute('/')({ component: () => <main>" + Array.from({ length: 600 }, (_, index) => `<Item${index} label="item-${index}" />`).join('') + '</main> })')
  return lines.join('\n')
}

async function startServer(sdkRoot) {
  const root = `${sdkRoot}/runtime/rolldown-parser`
  const assets = Object.fromEntries(['worker.js', 'pthread.js', 'parser.wasm'].map(name => [name, readFileSync(`${root}/${name}`)]))
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
    response.end('<!doctype html><title>Safari Rolldown workload memory probe</title><p>ready</p>')
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
const output = resolve(process.env.SAFARI_ROLLDOWN_REPORT ?? 'reports/safari-rolldown-workload-memory.json')
const iterations = Number(process.env.SAFARI_ROLLDOWN_ITERATIONS ?? 400)
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) throw Error('SAFARI_ROLLDOWN_ITERATIONS must be from 1 through 1000')
const source = realisticTSX()
const host = await startServer(sdkRoot)
let driverProcess
let driver
const report = {
  format: 1,
  startedAt: new Date().toISOString(),
  sdkRoot,
  browserVersion: null,
  safariPID: null,
  iterations,
  sourceBytes: Buffer.byteLength(source),
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
  await driver.navigate(host.origin)
  await driver.execute(`
    const source = arguments[0]
    const iterations = arguments[1]
    const state = globalThis.__rolldownProbe = {status: 'starting', completed: 0, error: null, startedAt: performance.now()}
    const worker = new Worker('/worker.js', {type: 'module'})
    state.worker = worker
    const pending = new Map()
    let sequence = 0
    const next = message => new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, {resolve, reject})
      worker.postMessage({...message, id})
    })
    worker.onmessage = ({data}) => {
      if (data?.type === 'ready') { state.ready?.(); return }
      if (data?.type === 'closed') { state.closed?.(data.resources); return }
      if (data?.type === 'error') { state.failed?.(Error(data.error)); return }
      if (data?.type === 'result') {
        const item = pending.get(data.id)
        pending.delete(data.id)
        if (item) data.error ? item.reject(Error(data.error)) : item.resolve(data.value)
      }
    }
    worker.onerror = event => state.failed?.(Error(event.message || 'Rolldown worker failed'))
    ;(async () => {
      try {
        await new Promise((resolve, reject) => {
          state.ready = resolve
          state.failed = reject
          worker.postMessage({type: 'start', wasmURL: location.origin + '/parser.wasm', pthreadURL: location.origin + '/pthread.js', policy: {timeoutMs: 30000, maxSourceBytes: 16 * 1024 * 1024}, profile: 'full'})
        })
        state.status = 'running'
        for (let index = 0; index < iterations; index++) {
          await next({type: 'parse', filename: '/project/route-' + index + '.tsx', source, options: {lang: 'tsx', sourceType: 'module'}})
          state.completed = index + 1
        }
        const resources = await new Promise((resolve, reject) => {
          state.closed = resolve
          state.failed = reject
          worker.postMessage({type: 'close'})
        })
        worker.terminate()
        state.resources = resources
        state.status = 'passed'
        state.durationMs = performance.now() - state.startedAt
      } catch (error) {
        state.status = 'failed'
        state.error = String(error)
        state.stack = error?.stack
        worker.terminate()
      }
    })()
    return {started: true}
  `, [source, iterations])
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const state = await driver.execute('const s=globalThis.__rolldownProbe; return s && {status:s.status,completed:s.completed,error:s.error,durationMs:s.durationMs,resources:s.resources}')
    report.samples.push({ at: new Date().toISOString(), state, processes: webContentProcesses() })
    if (state?.status === 'passed' || state?.status === 'failed') break
    await wait(1_000)
  }
  report.result = report.samples.at(-1)?.state
  if (!report.result || !['passed', 'failed'].includes(report.result.status)) report.result = { status: 'timeout' }
} finally {
  report.finishedAt = new Date().toISOString()
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  await driver?.close()
  await stopSafariDriver(driverProcess)
  if (report.safariPID) await stopSafariAutomationProcess(report.safariPID)
  await host.close()
}
console.log(output)
