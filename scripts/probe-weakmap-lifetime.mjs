import {readFileSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {weakmapLifetimeCases, weakmapLifetimeSource} from '../fixtures/weakmap-lifetime-cases.mjs'

const engine = JSON.parse(readFileSync('public/quickjs-als-wasm/build.json', 'utf8'))
const directory = engine.guestWasm.directory
if (!directory.includes('/quickjs-guest-wasm-')) throw Error('Unexpected build directory')
const source = join(directory, 'quickjs/quickjs.c')
const hash = data => createHash('sha256').update(data).digest('hex')
if (hash(readFileSync(source)) !== engine.guestWasm.quickjsSourceSHA256) throw Error('QuickJS source fingerprint mismatch')
const executable = join(directory, 'weakmap-lifetime-asan')
const fixture = join(directory, 'weakmap-lifetime.js')
writeFileSync(fixture, weakmapLifetimeSource)
const args = ['-O1', '-g', '-fsanitize=address', '-fno-omit-frame-pointer', '-D_GNU_SOURCE', '-DCONFIG_VERSION="spike"',
  '-I' + join(directory, 'quickjs'), resolve('fixtures/weakmap-lifetime-native.c'),
  ...['quickjs', 'dtoa', 'libregexp', 'libunicode', 'cutils'].map(name => join(directory, 'quickjs', name + '.c')),
  '-lm', '-o', executable]
const build = spawnSync('cc', args, {encoding: 'utf8', timeout: 120000})
const run = build.status === 0 ? spawnSync(executable, [fixture], {
  encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  env: {...process.env, ASAN_OPTIONS: 'abort_on_error=1'},
}) : undefined
const rows = run?.status === 0 ? JSON.parse(run.stdout).map(row => ({
  ...row, name: weakmapLifetimeCases[row.index].name,
  status: row.growth < 65536 ? 'reclaimed' : 'retention-gap',
  knownGap: weakmapLifetimeCases[row.index].knownGap ?? false,
})) : []
const unexpected = rows.filter(row => row.status !== 'reclaimed' && !row.knownGap)
const report = {
  engine, fixtureSHA256: hash(weakmapLifetimeSource), harnessSHA256: hash(readFileSync('fixtures/weakmap-lifetime-native.c')),
  scope: 'Native QuickJS reachability and allocation-retention probes under ASan, explicit GC between separate calls. Symbol back-reference retention remains a gap.',
  build: {status: build.status, stderr: build.stderr, error: String(build.error ?? '')},
  run: run && {status: run.status, signal: run.signal, error: String(run.error ?? ''), stderr: run.status === 0 ? '' : run.stderr},
  rows, unexpected: unexpected.length,
}
writeFileSync('reports/weakmap-lifetime.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({...report, engine: engine.wasmSha256}, null, 2))
if (build.status !== 0 || run?.status !== 0 || rows.length !== weakmapLifetimeCases.length || unexpected.length) process.exitCode = 1
