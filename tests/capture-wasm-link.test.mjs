import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const wrapper = resolve('scripts/capture-wasm-link.mjs')
function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'wasm-link-test-'))
  const linker = join(root, 'fake linker')
  writeFileSync(linker, '#!' + process.execPath + '\n' + body)
  chmodSync(linker, 0o755)
  const env = { ...process.env, LINK_EVIDENCE_LINKER: linker, LINK_EVIDENCE_DIRECTORY: root }
  return { root, env }
}
function records(root) {
  return readdirSync(root).filter(x => x.startsWith('link-')).map(x =>
    JSON.parse(readFileSync(join(root, x, 'invocation.json'))))
}
test('preserves argument order and spaces, captures identity and unique evidence paths', () => {
  const { root, env } = fixture('process.exit(0)')
  const args = ['one path.o', '--gc-sections', '-o', 'result.wasm']
  for (let i = 0; i < 2; i++) assert.equal(spawnSync(process.execPath, [wrapper, ...args], { env }).status, 0)
  const runs = records(root)
  assert.equal(runs.length, 2)
  for (const run of runs) {
    assert.deepEqual(run.originalArgs, args)
    assert.match(run.linkerSHA256, /^[a-f0-9]{64}$/)
    assert.equal(run.status, 0)
    assert.equal(run.error, null)
    assert.equal('env' in run, false)
    assert.equal(run.addedArgs.length, 3)
  }
  assert.notDeepEqual(runs[0].addedArgs, runs[1].addedArgs)
})
test('fake linker receives exact original arguments plus evidence flags', () => {
  const { env } = fixture(`const a=process.argv.slice(2); if(JSON.stringify(a.slice(0,4))!==JSON.stringify(['-flavor','wasm','a b','--gc-sections'])) process.exit(9); if(!a[4].startsWith('--Map=')||!a[5].startsWith('--reproduce=')||!a[6].startsWith('--why-extract=')) process.exit(8);`)
  assert.equal(spawnSync(process.execPath, [wrapper, 'a b', '--gc-sections'], { env }).status, 0)
})
test('propagates failing exit status and captures it', () => {
  const { root, env } = fixture('process.exit(17)')
  assert.equal(spawnSync(process.execPath, [wrapper], { env }).status, 17)
  assert.equal(records(root)[0].status, 17)
})
test('propagates termination signal after retaining evidence', () => {
  const { root, env } = fixture("process.kill(process.pid, 'SIGTERM')")
  assert.equal(spawnSync(process.execPath, [wrapper], { env }).signal, 'SIGTERM')
  assert.equal(records(root)[0].signal, 'SIGTERM')
})
test('captures spawn errors without discarding original invocation', () => {
  const { root, env } = fixture('')
  chmodSync(env.LINK_EVIDENCE_LINKER, 0o644)
  assert.equal(spawnSync(process.execPath, [wrapper], { env }).status, 1)
  assert.equal(records(root)[0].error.code, 'EACCES')
})
test('explicit rustup launcher receives the pinned tool and retains provenance', () => {
  const { root, env } = fixture('process.exit(0)')
  const launcher = join(root, 'fake rustup')
  writeFileSync(launcher, '#!' + process.execPath + '\n' + `const a=process.argv.slice(2); if(a[0]!=='run'||a[1]!=='1.98.1'||a[2]!==process.env.LINK_EVIDENCE_LINKER||a[3]!=='-flavor'||a[4]!=='wasm'||a[5]!=='a b')process.exit(19)`)
  chmodSync(launcher, 0o755)
  Object.assign(env, {LINK_EVIDENCE_RUSTUP:launcher, LINK_EVIDENCE_TOOLCHAIN:'1.98.1', RUSTUP_HOME:root})
  env.LINK_EVIDENCE_LINKER=realpathSync(env.LINK_EVIDENCE_LINKER)
  assert.equal(spawnSync(process.execPath, [wrapper, 'a b'], {env}).status, 0)
  const run=records(root)[0]
  assert.equal(run.launcher.toolchain,'1.98.1')
  assert.match(run.launcher.sha256,/^[a-f0-9]{64}$/)
  assert.deepEqual(run.originalArgs,['a b'])
})
test('partial launcher configuration fails before linking', () => {
  const {root,env}=fixture('process.exit(0)')
  env.LINK_EVIDENCE_TOOLCHAIN='1.98.1'
  assert.equal(spawnSync(process.execPath,[wrapper],{env}).status,1)
  assert.equal(records(root).length,0)
})
test('Cargo supplied linker flavor is preserved without duplication', () => {
  const {root,env}=fixture(`if(process.argv.slice(2).filter(a=>a==='-flavor').length!==1)process.exit(20)`)
  assert.equal(spawnSync(process.execPath,[wrapper,'-flavor','wasm','input.o'],{env}).status,0)
  assert.deepEqual(records(root)[0].flavorArgs,[])
  assert.deepEqual(records(root)[0].originalArgs,['-flavor','wasm','input.o'])
})
