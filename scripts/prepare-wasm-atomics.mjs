import {readFileSync, writeFileSync, mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {atomicCases} from './wasm-atomics-cases.mjs'

import {fixtureAssembler} from './fixture-toolchains.mjs'
const {assembler,command,prefix}=fixtureAssembler()
const source = readFileSync('fixtures/shared-wasm/atomic-coverage.wat', 'utf8')
if (!source.includes('(memory 1 2 shared)')) throw Error('Missing shared import declaration')
const directory = mkdtempSync(join(tmpdir(), 'wasm-atomic-coverage-'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fixtures = []
for (const shared of [true, false]) {
  const name = shared ? 'atomic-coverage' : 'atomic-coverage-unshared'
  const text = shared ? source : source.replace('(memory 1 2 shared)', '(memory 1 2)')
  const input = join(directory, name + '.wat')
  const output = 'fixtures/shared-wasm/' + name + '.wasm'
  writeFileSync(input, text)
  const run = spawnSync(command, [...prefix, '--enable-threads', name + '.wat', '-o', name + '.wasm'], {cwd:directory, encoding:'utf8', timeout:30000})
  if (run.status !== 0) throw Error(String(run.error ?? '') + run.stderr + run.stdout)
  const bytes = readFileSync(join(directory, name + '.wasm'))
  if (!WebAssembly.validate(bytes)) throw Error('Native WebAssembly rejected ' + name)
  writeFileSync(output, bytes)
  fixtures.push({name, sourceSHA256:sha(text), wasmSHA256:sha(bytes), bytes:bytes.length})
}
const cases = atomicCases(WebAssembly, readFileSync('fixtures/shared-wasm/atomic-coverage.wasm'), readFileSync('fixtures/shared-wasm/atomic-coverage-unshared.wasm'))
writeFileSync('fixtures/shared-wasm/atomic-coverage-manifest.json', JSON.stringify({assemblerSHA256:sha(readFileSync(assembler)), fixtures, nativeVersion:process.version, cases}, null, 2) + '\n')
console.log('Prepared atomic coverage fixtures and ' + cases.length + ' native reference results')
