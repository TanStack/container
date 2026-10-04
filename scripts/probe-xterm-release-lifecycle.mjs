import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, firefox, webkit } from 'playwright'

export function xtermLifecyclePlan(args, env = process.env) {
  assert.equal(args.length, 1, 'Pass the private installed terminal fixture')
  const fixture = resolve(args[0])
  assert.match(fixture, /^\/private\/tmp\/(?:tanstack-native-site|native-xterm-release)-[A-Za-z0-9]+$/)
  const browsers = env.NATIVE_BROWSER ? [env.NATIVE_BROWSER] : ['chromium', 'firefox', 'webkit']
  assert.ok(browsers.every(name => ['chromium', 'firefox', 'webkit'].includes(name)))
  const repetitions = Number(env.NATIVE_XTERM_REPETITIONS ?? 20)
  assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 100)
  return { fixture, browsers, repetitions }
}

export function xtermLifecycleAssets(fixture) {
  const packages = ['xterm', 'addon-fit'].map(name => {
    const directory = join(fixture, 'node_modules/@xterm', name)
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json')))
    assert.equal(metadata.name, '@xterm/' + name)
    assert.ok(name === 'xterm' ? ['5.5.0', '6.0.0'].includes(metadata.version)
      : ['0.10.0', '0.11.0'].includes(metadata.version), 'Use the known baseline or official release pair')
    assert.equal(metadata.main, name === 'xterm' ? 'lib/xterm.js' : 'lib/addon-fit.js')
    return { name: metadata.name, version: metadata.version, directory, main: metadata.main }
  })
  assert.equal(packages[1].version, packages[0].version === '5.5.0' ? '0.10.0' : '0.11.0')
  const assets = new Map([
    ['/xterm.js', readFileSync(join(packages[0].directory, packages[0].main))],
    ['/fit.js', readFileSync(join(packages[1].directory, packages[1].main))],
    ['/xterm.css', readFileSync(join(packages[0].directory, 'css/xterm.css'))],
  ])
  return { packages, assets }
}

async function main() {
  const plan = xtermLifecyclePlan(process.argv.slice(2))
  const { packages, assets } = xtermLifecycleAssets(plan.fixture)
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const directory = mkdtempSync('/private/tmp/native-xterm-lifecycle-')
  const report = { plan, packages, assets: Object.fromEntries([...assets].map(([path, bytes]) => [path,
    { bytes: bytes.length, sha256: hash(bytes) }])), runnerSHA256: hash(readFileSync(process.argv[1])), rows: [], passed: false }
  const output = join(directory, 'results.json')
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method !== 'GET') { response.writeHead(405).end(); return }
    response.setHeader('Cache-Control', 'no-store')
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><html><head><link rel="stylesheet" href="/xterm.css"></head><body>' +
        '<script src="/xterm.js"></script><script src="/fit.js"></script></body></html>')
    } else if (assets.has(path)) {
      response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
      response.end(assets.get(path))
    } else response.writeHead(404).end()
  })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const origin = 'http://127.0.0.1:' + server.address().port
  console.log('Xterm lifecycle report: ' + output)
  try {
    for (const name of plan.browsers) {
      const browser = await { chromium, firefox, webkit }[name].launch({ headless: true })
      const errors = []
      try {
        const page = await browser.newPage()
        page.on('pageerror', error => errors.push({ name: error.name, message: error.message }))
        await page.goto(origin)
        const mounts = await page.evaluate(async repetitions => {
          let mounted = 0
          for (let index = 0; index < repetitions; index++) {
            const container = document.createElement('div')
            container.style.cssText = 'width:640px;height:240px'
            document.body.append(container)
            const terminal = new window.Terminal()
            const fit = new window.FitAddon.FitAddon()
            terminal.loadAddon(fit)
            terminal.open(container)
            fit.fit()
            if (!(terminal.cols > 0 && terminal.rows > 0)) throw Error('Terminal never mounted')
            mounted++
            terminal.dispose()
            container.remove()
            // Drain the callbacks which could outlive the disposed renderer.
            await new Promise(done => setTimeout(done, 25))
          }
          return mounted
        }, plan.repetitions)
        assert.equal(mounts, plan.repetitions)
        report.rows.push({ browser: name, version: browser.version(), mounts, errors, passed: errors.length === 0 })
        console.log(JSON.stringify(report.rows.at(-1)))
      } catch (error) {
        report.rows.push({ browser: name, version: browser.version(), errors, passed: false, error: String(error) })
      } finally { await browser.close() }
      writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    }
    assert.equal(hash(readFileSync(process.argv[1])), report.runnerSHA256, 'Probe changed during the batch')
    const after = xtermLifecycleAssets(plan.fixture)
    for (const [path, bytes] of after.assets) assert.equal(hash(bytes), report.assets[path].sha256, 'Installed asset changed')
    report.passed = report.rows.length === plan.browsers.length && report.rows.every(row => row.passed)
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    if (!report.passed) process.exitCode = 1
  } finally { await new Promise(done => server.close(done)) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
