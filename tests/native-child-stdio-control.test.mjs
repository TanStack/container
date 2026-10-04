import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {nativeChildStdioFiles,nativeChildStdioExpected} from './fixtures/native-child-stdio.mjs'

test('pipe and ignore combinations match real Node',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'container-stdio-control-'))
  for(const [path,source] of Object.entries(nativeChildStdioFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['stdio-main.cjs'],{cwd:directory,stdio:'inherit'})
    const timer=setTimeout(()=>{child.kill();reject(Error('Node stdio control timed out'))},15000)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Node stdio control exited '+code))})
  })
  assert.deepEqual(JSON.parse(await readFile(join(directory,'stdio-result.json'),'utf8')),nativeChildStdioExpected)
})
