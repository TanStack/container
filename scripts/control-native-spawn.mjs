import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import assert from 'node:assert/strict'
import {nativeSpawnFiles} from '../tests/fixtures/native-spawn.mjs'
const directory=await mkdtemp(join(tmpdir(),'container-spawn-control-'))
for(const [path,source] of Object.entries(nativeSpawnFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['spawn-main.js'],{cwd:directory,stdio:'inherit'})
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Control exited '+code)))
})
const result=JSON.parse(await readFile(join(directory,'spawn-result.json'),'utf8'))
assert.deepEqual(result,{spawned:true,code:0,signal:null,stdout:[255,0,240,159,152,128],stderr:'child warning\n',connected:false,closedAfterOutputEnd:true,
  unread:{code:0,signal:null,stdoutEnded:true,stderrEnded:true}})
assert.equal(await readFile(join(directory,'spawn-child-ended'),'utf8'),'yes')
console.log(JSON.stringify({directory,node:process.version,result}))
