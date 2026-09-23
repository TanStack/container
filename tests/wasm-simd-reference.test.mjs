import {test} from 'node:test'
import {deepStrictEqual,strictEqual} from 'node:assert'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {simdFixtures} from '../scripts/wasm-simd-fixtures.mjs'

for(const {name,manifest:manifestName,run,expected} of simdFixtures){
  test(`native SIMD reference: ${name}`,()=>{
    const dir=new URL('../fixtures/wasm-simd/',import.meta.url)
    const bytes=readFileSync(new URL(name+'.wasm',dir))
    const source=readFileSync(new URL(name+'.wat',dir))
    const manifest=JSON.parse(readFileSync(new URL(manifestName+'.json',dir),'utf8'))
    const hash=value=>createHash('sha256').update(value).digest('hex')
    strictEqual(hash(bytes),manifest.wasmSHA256)
    strictEqual(hash(source),manifest.sourceSHA256)
    strictEqual(WebAssembly.validate(bytes),true)
    deepStrictEqual(run(WebAssembly,bytes),manifest.native)
    deepStrictEqual(manifest.native,expected)
  })
}
