import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import assert from 'node:assert/strict'
import {nativeExecFileFiles,nativeExecFileExpected} from '../tests/fixtures/native-exec-file.mjs'
const directory=await mkdtemp(join(tmpdir(),'container-exec-file-control-'))
for(const [path,source] of Object.entries(nativeExecFileFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['exec-main.js'],{cwd:directory,stdio:'inherit'})
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Control exited '+code)))
})
const results=JSON.parse(await readFile(join(directory,'exec-result.json'),'utf8'))
assert.deepEqual(results,nativeExecFileExpected)
console.log(JSON.stringify({directory,node:process.version,results}))
