import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import assert from 'node:assert/strict'
import {nativeChildAbortFiles,nativeChildAbortExpected} from '../tests/fixtures/native-child-abort.mjs'
const directory=await mkdtemp(join(tmpdir(),'container-abort-control-'))
for(const [path,source] of Object.entries(nativeChildAbortFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['abort-main.js'],{cwd:directory,stdio:'inherit'})
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Control exited '+code)))
})
const results=JSON.parse(await readFile(join(directory,'abort-result.json'),'utf8'))
assert.deepEqual(results,nativeChildAbortExpected)
console.log(JSON.stringify({directory,node:process.version,results}))
