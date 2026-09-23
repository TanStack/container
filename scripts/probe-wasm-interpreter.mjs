import {readFile, writeFile} from 'node:fs/promises'
import {runProbe} from '../fixtures/wasm-interpreter/run.mjs'
const suffix=process.argv.includes('--ubsan')?'-ubsan':''
const base=new URL('../public/wasm-interpreter-probe'+suffix+'/',import.meta.url)
const {default:createEngine}=await import(new URL('engine.mjs',base))
const engine = await createEngine()
const report = await runProbe(engine, name => readFile(new URL(name, base)),
  row => console.log(`${row.passed ? 'PASS' : 'FAIL'} ${row.name}${row.error ? ': ' + row.error : ''}`))
report.build = JSON.parse(await readFile(new URL('build.json', base), 'utf8'))
await writeFile('reports/wasm-interpreter-node'+suffix+'.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({passed: report.passed, failed: report.failed}))
if (report.failed) process.exitCode = 1
