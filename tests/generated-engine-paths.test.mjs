import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeCompilerSourcePaths,normalizeInspectionWrapperPaths} from '../scripts/generated-engine-paths.mjs'

test('normalizes Emscripten source paths in generated engine wrappers',()=>{
  const source='/tmp/build-a/.toolchains/quickjs-emscripten'
  const generated=`// include: ${source}/templates/pre-extension.js\n`
  assert.equal(normalizeCompilerSourcePaths(generated,source),'// include: /sources/quickjs-emscripten/templates/pre-extension.js\n')
})

test('uses esbuild metadata to normalize inspection wrapper paths',()=>{
  const staging='/var/folders/random/T/quickjs-stacktrace-ABC123'
  const input='../../../var/folders/random/T/quickjs-stacktrace-ABC123/inspection-core/debug.ts'
  const generated=`// ${input}\nconst source = "${input}";\n`
  const normalized=normalizeInspectionWrapperPaths(generated,[input],staging)
  assert.equal(normalized,'// /sources/quickjs-staged/inspection-core/debug.ts\nconst source = "/sources/quickjs-staged/inspection-core/debug.ts";\n')
  assert.equal(normalized.includes('quickjs-stacktrace-ABC123'),false)
})

test('refuses to package an inspection wrapper without its staging input',()=>{
  assert.throws(
    ()=>normalizeInspectionWrapperPaths('const source = 1',['src/index.ts'],'/tmp/quickjs-stacktrace-missing'),
    /did not identify the staged inspection wrapper/,
  )
})
