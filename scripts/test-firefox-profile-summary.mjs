import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'

const directory=mkdtempSync(join(tmpdir(),'firefox-summary-test-'))
const input=join(directory,'input.json'),output=join(directory,'output.json')
const thread={name:'DOM Worker',tid:1,
  stringTable:['engine.wasm.first (http://local/engine.wasm:1)','engine.wasm.second (http://local/engine.wasm:2)'],
  frameTable:{schema:{location:0},data:[[0],[1]]},
  stackTable:{schema:{prefix:0,frame:1},data:[[null,0],[0,1],[1,0]]},
  samples:{schema:{stack:0},data:[[2],[2],[1],[null]]}}
writeFileSync(input,JSON.stringify({processes:[{threads:[thread]}]}))
execFileSync(process.execPath,[resolve('scripts/summarize-firefox-profile.mjs'),input,output])
const result=JSON.parse(readFileSync(output))
assert.equal(result.threads.length,1)
assert.equal(result.threads[0].sampled,3)
assert.deepEqual(result.threads[0].wasmLeafSamples,[{name:'first',count:2},{name:'second',count:1}])
assert.deepEqual(result.threads[0].inclusiveWasmSamples,[{name:'first',count:3},{name:'second',count:3}])
assert.match(result.sha256,/^[a-f0-9]{64}$/)
console.log('Profile summary counts leaf and recursive inclusive samples correctly')
