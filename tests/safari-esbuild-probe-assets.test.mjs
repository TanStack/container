import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {applyWasmMemoryPolicy} from '../src/compiler/wasm-memory-policy.ts'
import {prepareSafariEsbuildProbe} from '../scripts/safari-esbuild-probe-assets.mjs'

test('Safari esbuild probe applies the exact production 1024-page policy',()=>{
  const original=readFileSync('node_modules/esbuild-wasm/esbuild.wasm')
  const expected=applyWasmMemoryPolicy(original,1024)
  const actual=prepareSafariEsbuildProbe(original)
  assert.equal(actual.minPages,expected.minPages)
  assert.equal(actual.declaredMaxPages,1024)
  assert.deepEqual(actual.bytes,expected.bytes)
  assert.throws(()=>prepareSafariEsbuildProbe(original,2048),/production 1024-page cap/)
})
