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

async function startServer(modulePath) {
  const bytes = readFileSync(modulePath)
  const server = createServer((request, response) => {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    }
    if (request.url === '/module.wasm') {
      response.writeHead(200, { ...headers, 'Content-Type': 'application/wasm' })
      response.end(bytes)
      return
    }
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Safari WebAssembly compile memory probe</title><p id="ready">ready</p>')
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return {
    bytes,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  }
}

async function compileOnce(driver) {
  return driver.executeAsync(`
    const done = arguments[0]
    ;(async () => {
      globalThis.__probeBytes ??= await (await fetch('/module.wasm', {cache: 'no-store'})).arrayBuffer()
      globalThis.__probeModules ??= []
      const startedAt = performance.now()
      const module = await WebAssembly.compile(globalThis.__probeBytes)
      globalThis.__probeModules.push(module)
      done({durationMs: performance.now() - startedAt, retainedModules: globalThis.__probeModules.length, byteLength: globalThis.__probeBytes.byteLength})
    })().catch(error => done({error: String(error), stack: error?.stack}))
  `, [], 120_000)
}

async function probeModule(name, modulePath) {
  const host = await startServer(modulePath)
  let driverProcess
  let driver
  let safariPID
  try {
    assertSafariAutomationAvailable()
    const started = await startSafariDriver({})
    driverProcess = started.child
    driver = started.driver
    const capabilities = await driver.createSession()
    await driver.maximizeWindow()
    const safari = await activateSafariAutomation()
    safariPID = safari.pid
    await driver.navigate(host.origin)
    const afterNavigation = webContentProcesses()
    const first = await compileOnce(driver)
    if (first.error) throw Error(`${name} first compile failed: ${first.error}`)
    await wait(5_000)
    const afterFirstCompile = webContentProcesses()
    const second = await compileOnce(driver)
    if (second.error) throw Error(`${name} second compile failed: ${second.error}`)
    await wait(5_000)
    const afterSecondCompile = webContentProcesses()
    return {
      name,
      modulePath: resolve(modulePath),
      moduleBytes: host.bytes.length,
      moduleSHA256: sha256(host.bytes),
      browserVersion: capabilities.browserVersion ?? capabilities.version ?? null,
      safariPID: safari.pid,
      compiles: [first, second],
      processes: { afterNavigation, afterFirstCompile, afterSecondCompile },
    }
  } finally {
    await driver?.close()
    await stopSafariDriver(driverProcess)
    if (safariPID) await stopSafariAutomationProcess(safariPID)
    await host.close()
  }
}

const sdkRoot = process.env.SDK_OUTPUT
if (!sdkRoot) throw Error('Set SDK_OUTPUT to the exact packaged SDK directory')
const output = resolve(process.env.SAFARI_WASM_COMPILE_REPORT ?? 'reports/safari-wasm-compile-memory.json')
const modulePaths = {
  'quickjs-fiber-wasm': `${sdkRoot}/runtime/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage/engine.wasm`,
  'rolldown-parser': `${sdkRoot}/runtime/rolldown-parser/parser.wasm`,
  esbuild: `${sdkRoot}/runtime/compiler/esbuild.wasm`,
  'quickjs-sync': `${sdkRoot}/runtime/quickjs-als/engine.wasm`,
}
const report = { format: 1, startedAt: new Date().toISOString(), sdkRoot: resolve(sdkRoot), modules: [] }
try {
  for (const [name, modulePath] of Object.entries(modulePaths)) report.modules.push(await probeModule(name, modulePath))
} finally {
  report.finishedAt = new Date().toISOString()
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
}
console.log(output)
