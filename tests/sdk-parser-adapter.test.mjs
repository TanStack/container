import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {buildRolldownAdapter} from '../scripts/build-rolldown-parser.mjs'

test('parser adapter contains our code but leaves upstream packages external',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sdk-parser-adapter-test-'))
  const output=join(root,'adapter')
  const result=await buildRolldownAdapter(output)
  assert.deepEqual(readdirSync(output),['worker.mjs'])
  assert.ok(result.inputs.length>0)
  assert.ok(result.inputs.every(path=>path.startsWith('src/')&&!path.includes('node_modules')))
  const text=readFileSync(result.entry,'utf8')
  for(const name of ['@napi-rs/wasm-runtime','@napi-rs/wasm-runtime/fs','@emnapi/runtime'])assert.ok(text.includes('from "'+name+'"'))
  assert.match(result.sha256,/^[a-f0-9]{64}$/)
  await assert.rejects(buildRolldownAdapter(output),{code:'EEXIST'})
})
