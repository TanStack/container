import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync,spawn} from 'node:child_process'
import {nativeInheritedInputFiles,nativeInheritedInputBytes,nativeInheritedInputExpected,nativeInheritedLargeInputBytes,nativeInheritedLargeInputExpected,nativeInheritedCompetingExpected,nativeInheritedCancelledExpected,nativeForkDefaultExpected} from './fixtures/native-child-inherited-input.mjs'
test('inherited input delivers binary bytes and closes with real Node',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'container-inherited-input-'))
  for(const [path,source] of Object.entries(nativeInheritedInputFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
  for(const [entry,input,expected] of [['input-parent.cjs',nativeInheritedInputBytes,nativeInheritedInputExpected],['input-nested.cjs',nativeInheritedInputBytes,nativeInheritedInputExpected],['input-large-parent.cjs',nativeInheritedLargeInputBytes,nativeInheritedLargeInputExpected],['input-competing-parent.cjs',nativeInheritedLargeInputBytes,nativeInheritedCompetingExpected]]){
  const result=spawnSync(process.execPath,[entry],{cwd:directory,input,encoding:'utf8',timeout:10000})
  assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.stderr,'')
  assert.deepEqual(JSON.parse(result.stdout),expected)
  }
})
test('fork defaults, silent pipes and explicit stdio precedence match Node',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'container-fork-default-'))
  for(const [path,source] of Object.entries(nativeInheritedInputFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
  const result=spawnSync(process.execPath,['input-fork-parent.cjs'],{cwd:directory,input:nativeInheritedInputBytes,encoding:'utf8',timeout:10000})
  assert.equal(result.error,undefined);assert.equal(result.status,0)
  assert.equal(result.stderr,'default-err\nexplicit-err\n')
  assert.equal(result.stdout,'default-out\nexplicit-out\n'+JSON.stringify(nativeForkDefaultExpected)+'\n')
})
test('cancelled inherited read leaves later input for the replacement child',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'container-input-cancel-'))
  for(const [path,source] of Object.entries(nativeInheritedInputFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['input-cancel-parent.cjs'],{cwd:directory,timeout:10000})
    let stdout='',stderr='',sent=false
    child.stdout.on('data',bytes=>{
      stdout+=bytes
      if(!sent&&stdout.includes('READY\n')){sent=true;child.stdin.end(nativeInheritedInputBytes)}
    })
    child.stderr.on('data',bytes=>stderr+=bytes)
    child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal,stdout,stderr}))
  })
  assert.deepEqual(result,{code:0,signal:null,stdout:'READY\n'+JSON.stringify(nativeInheritedCancelledExpected)+'\n',stderr:''})
})
