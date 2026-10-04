import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import assert from 'node:assert/strict'
import {nativeNodeEvalFiles,nativeNodeEvalExpected,nativeNodeEsmExpected,nativeNodeEsmFailuresExpected} from '../tests/fixtures/native-node-eval.mjs'
const directory=await mkdtemp(join(tmpdir(),'container-eval-control-'))
for(const [path,source] of Object.entries(nativeNodeEvalFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
await new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['eval-main.js'],{cwd:directory,stdio:'inherit'});
 child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Control exited '+code)))
})
const result=JSON.parse(await readFile(join(directory,'eval-result.json'),'utf8'))
assert.deepEqual(result,{...nativeNodeEvalExpected,esm:nativeNodeEsmExpected,esmFailures:nativeNodeEsmFailuresExpected})
console.log(JSON.stringify({directory,node:process.version,cases:result.results.length+2+result.stdinCases.length+result.esm.length+result.esmFailures.length}))
