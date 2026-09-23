import {test, expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync, realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve, sep, extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root = realpathSync(process.env.SDK_OUTPUT)
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const enabled = ['experimental-fibers-simd','experimental-fibers-simd-lazy'].includes(manifest.buildProfile)
const packageName = '@astrojs/compiler-binding-wasm32-wasi'
const fixtureRoot = resolve('fixtures/compiler-wasi-astro')
let server, url, fixture

test.beforeAll(async () => {
  if (!enabled) return
  fixture = JSON.stringify(await collectInstalledClosure(fixtureRoot, [packageName]))
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/') {
      res.setHeader('content-type', 'text/html')
      res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>')
      return
    }
    if (path === '/fixture.json') {
      res.setHeader('content-type', 'application/json')
      res.end(fixture)
      return
    }
    try {
      if (!path.startsWith('/sdk/')) throw Error('outside package')
      const file = realpathSync(resolve(root, decodeURIComponent(path.slice(5))))
      if (!file.startsWith(root + sep)) throw Error('outside package')
      res.setHeader('content-type', ({'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json'})[extname(file)] ?? 'application/octet-stream')
      res.end(readFileSync(file))
    } catch {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  url = `http://127.0.0.1:${server.address().port}`
})
test.afterAll(async () => { if (server) await new Promise(done => server.close(done)) })

const plainSort = `console.log('phase:before-sort');
console.log(JSON.stringify(['answer','add'].sort()));
console.log('phase:after-sort');`
const sortBeforeOutput = `const sorted=['answer','add'].sort();
console.log('phase:sort-completed-before-first-output');
console.log(JSON.stringify(sorted));`
const numericBeforeOutput = `const sorted=[3,1,2].sort((a,b)=>a-b);
console.log('phase:numeric-sort-completed-before-first-output');
console.log(JSON.stringify(sorted));`
const numericAfterOutput = `console.log('phase:before-numeric-sort');
const sorted=[3,1,2].sort((a,b)=>a-b);
console.log('phase:after-numeric-sort');
console.log(JSON.stringify(sorted));`
const requireBinding = `console.log('phase:before-require');
const binding=require(${JSON.stringify(packageName)});
console.log('phase:after-require');`
const readKeys = `${requireBinding}
console.log('phase:before-keys');
const keys=Object.keys(binding);
console.log('phase:after-keys');`
const cases = [
  ...['execute','module'].map(mode=>({name:`${mode} string sort without guest WASM`,mode,guestWasm:false,source:sortBeforeOutput})),
  {name: 'plain execute string sort', mode: 'execute', source: plainSort},
  {name: 'CJS entry string sort', mode: 'module', source: plainSort},
  ...['execute', 'module'].flatMap(mode => [
    {name: `${mode} string sort before first output`, mode, source: sortBeforeOutput},
    {name: `${mode} numeric comparator before first output`, mode, source: numericBeforeOutput},
    {name: `${mode} numeric comparator after output`, mode, source: numericAfterOutput},
  ]),
  {name: 'Astro require without key enumeration', mode: 'module', binding: true,
    source: `${requireBinding}\nconsole.log(typeof binding.parseAstroSync);`},
  {name: 'Astro key enumeration without sort', mode: 'module', binding: true,
    source: `${readKeys}\nconsole.log(JSON.stringify(keys));`},
  {name: 'Astro key enumeration with sort', mode: 'module', binding: true,
    source: `${readKeys}\nconsole.log('phase:before-sort');keys.sort();console.log('phase:after-sort');console.log(JSON.stringify(keys));`},
]

for (const sample of cases) test(`packaged SIMD sort isolation: ${sample.name}`, async ({page}, info) => {
  test.skip(!enabled, 'Requires experimental-fibers-simd package')
  test.setTimeout(60000)
  const native = spawnSync(process.execPath, ['-e', sample.source + '\nprocess.exit(0)'], {
    cwd: fixtureRoot, encoding: 'utf8', timeout: 15000,
  })
  expect(native.status, native.stderr || native.error?.message).toBe(0)
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.sdk))
  const observed = await page.evaluate(async sample => {
    const files = {}
    if (sample.binding) {
      const snapshot = await fetch('/fixture.json').then(response => response.json())
      for (const [path, value] of Object.entries(snapshot.files)) {
        files['/project' + path] = Uint8Array.from(atob(value.base64), char => char.charCodeAt(0))
      }
    }
    files['/project/main.cjs'] = sample.source
    const policy = {experimentalFibers: true, sharedMemoryPerEngine: {maxBytes: 512 * 1024 * 1024}, maxBytes: 256 * 1024 * 1024, timeoutMs: 15000, workspace: {maxBytes: 64 * 1024 * 1024}}
    const kernel = new window.sdk.WorkerKernel(files, policy)
    const output = []
    const options = {cwd: '/project', guestWasm: sample.guestWasm!==false, webAPIs: true, timeoutMs: 15000, maxBytes: 256 * 1024 * 1024, onOutput: (level, text) => output.push({level, text})}
    const start = performance.now()
    let outcome, closeError
    try {
      const result = sample.mode === 'execute'
        ? await kernel.execute(sample.source, options)
        : await kernel.runModule('/project/main.cjs', options)
      outcome = {result}
    } catch (error) {
      outcome = {error: {name: error.name, message: error.message}}
    } finally {
      try { kernel.close() }
      catch (error) { closeError = {name: error.name, message: error.message} }
    }
    return {...outcome, closeError, output, elapsedMs: performance.now() - start}
  }, sample)
  const evidence=info.outputPath('simd-sort-isolation.json')
  await writeFile(evidence,JSON.stringify({profile: manifest.buildProfile, sample, native: {status: native.status, stdout: native.stdout, stderr: native.stderr}, observed}, null, 2))
  await info.attach('simd-sort-isolation.json',{path:evidence,contentType:'application/json'})
  expect(observed.error, JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode, observed.result.stderr).toBe(0)
  expect(observed.result.stdout).toBe(native.stdout)
  expect(observed.closeError, JSON.stringify(observed)).toBeUndefined()
})
