import {test} from 'node:test'
import assert from 'node:assert/strict'
import {transformToolchainDynamicImports} from '../scripts/toolchain-dynamic-imports.mjs'

test('routes computed imports but preserves bundle-time imports and lexical name collisions',()=>{
  const result=transformToolchainDynamicImports("const _runtimeImport=1; import('vite'); import(path, options);",'/loader.ts')
  assert.match(result,/import\('vite'\)/)
  assert.match(result,/importRuntimeModule as _runtimeImport2/)
  assert.match(result,/_runtimeImport2\(path, options\)/)
})
test('leaves modules with no computed imports unchanged',()=>{
  const source="export const value=import('vite')"
  assert.equal(transformToolchainDynamicImports(source,'/loader.ts'),source)
})
