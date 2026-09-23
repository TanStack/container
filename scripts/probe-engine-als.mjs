import { readFileSync, writeFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'
import patchedLoader from '../public/quickjs-als/engine.mjs'
import { createHash } from 'node:crypto'

const cases = JSON.parse(readFileSync('src/feasibility/als-cases.json', 'utf8'))
const bootstrap = readFileSync('src/sandbox/engine-als-bootstrap.js', 'utf8')
const patched = await newQuickJSWASMModuleFromVariant(newVariant({ ...RELEASE_SYNC,
  importModuleLoader: async () => patchedLoader,
}, {
  wasmBinary: readFileSync('public/quickjs-als/engine.wasm'),
}))
const stock = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC)
const results = []
for (const fixture of cases) {
  const expected = JSON.stringify(await new Function('ALS', `return (async()=>{${fixture.code}})()`)(AsyncLocalStorage))
  const row = { id: fixture.id, expected }
  for (const [label, engine] of [['stock', stock], ['patched', patched]]) {
    const runtime = engine.newRuntime()
    runtime.setMemoryLimit(16 * 1024 * 1024)
    runtime.setMaxStackSize(512 * 1024)
    const deadline = Date.now() + 5000
    runtime.setInterruptHandler(() => Date.now() > deadline)
    const ctx = runtime.newContext()
    const handles = []
    try {
      if (label === 'stock') handles.push(ctx.unwrapResult(ctx.evalCode(`{
        let frame; globalThis.__qjsGetAsyncContext=()=>frame;
        globalThis.__qjsSetAsyncContext=value=>{frame=value};
      }`)))
      handles.push(ctx.unwrapResult(ctx.evalCode(bootstrap)))
      const result = ctx.unwrapResult(ctx.evalCode(`(async()=>{const ALS=__engineAsyncLocalStorage;${fixture.code}})()`, fixture.id + '.js'))
      handles.push(result)
      for (;;) {
        const state = ctx.getPromiseState(result)
        if (state.type === 'fulfilled') {
          row[label] = JSON.stringify(ctx.dump(state.value)); state.value.dispose(); break
        }
        if (state.type === 'rejected') {
          row[label] = { error: ctx.dump(state.error) }; state.error.dispose(); break
        }
        if (!runtime.hasPendingJob() || Date.now() > deadline) throw new Error('Unsettled promise')
        ctx.unwrapResult(runtime.executePendingJobs(100))
      }
      row[label + 'Matches'] = row[label] === expected
    } catch (error) { row[label] = { error: String(error) }; row[label + 'Matches'] = false }
    finally { handles.reverse().forEach(h=>h.dispose()); ctx.dispose(); runtime.dispose() }
  }
  results.push(row)
  console.log(`${row.patchedMatches ? 'PASS' : 'GAP '} ${row.id}${row.patchedMatches ? '' : ': ' + JSON.stringify(row)}`)
}
const report = { node: process.version, nativeAwait: true,
  corpusSHA256: createHash('sha256').update(readFileSync('src/feasibility/als-cases.json')).digest('hex'),
  build: JSON.parse(readFileSync('public/quickjs-als/build.json','utf8')), results }
writeFileSync('reports/engine-als.json', JSON.stringify(report, null, 2) + '\n')
writeFileSync('public/quickjs-als/reference.json', JSON.stringify(report, null, 2) + '\n')
console.log(`Patched ${results.filter(x=>x.patchedMatches).length}/${results.length}, stock ${results.filter(x=>x.stockMatches).length}/${results.length}`)
if (results.some(x=>!x.patchedMatches)) process.exitCode=1
