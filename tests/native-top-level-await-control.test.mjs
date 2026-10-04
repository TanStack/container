import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

function run(source,inputType='module'){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type='+inputType,'--eval',source],{stdio:['ignore','pipe','pipe']})
    let stdout='',stderr=''
    const timeout=setTimeout(()=>{child.kill();reject(Error('Node control did not exit within 10 seconds'))},10000)
    child.stdout.setEncoding('utf8').on('data',value=>{stdout+=value})
    child.stderr.setEncoding('utf8').on('data',value=>{stderr+=value})
    child.once('error',error=>{clearTimeout(timeout);reject(error)})
    child.once('close',(code,signal)=>{clearTimeout(timeout);resolve({code,signal,stdout,stderr})})
  })
}

test('unresolved top-level await exits once referenced work is gone',async()=>{
  for(const source of [
    'console.log("started"); await new Promise(()=>{})',
    'setTimeout(()=>console.log("timer"),20); console.log("started"); await new Promise(()=>{})',
    'setInterval(()=>{},1000).unref(); console.log("started"); await new Promise(()=>{})',
  ]){
    const result=await run(source)
    assert.equal(result.code,13,JSON.stringify(result))
    assert.equal(result.signal,null)
    assert.equal(result.stdout,source.includes('"timer"')?'started\ntimer\n':'started\n')
    assert.match(result.stderr,/unsettled top-level await/i)
  }
})

test('a referenced timer can resolve top-level await normally',async()=>{
  const result=await run('await new Promise(resolve=>setTimeout(resolve,20)); console.log("resolved")')
  assert.deepEqual(result,{code:0,signal:null,stdout:'resolved\n',stderr:''})
})

test('a nonzero requested exit code takes precedence over unsettled await',async()=>{
  for(const code of [7,13]){
    const result=await run(`process.exitCode=${code}; await new Promise(()=>{})`)
    assert.deepEqual(result,{code,signal:null,stdout:'',stderr:''})
  }
  const zero=await run('process.exitCode=0; await new Promise(()=>{})')
  assert.equal(zero.code,13)
  assert.match(zero.stderr,/unsettled top-level await/i)
})

test('importing an already evaluating module does not pin an unresolved await',async()=>{
  const result=await run('const url="data:text/javascript,"+encodeURIComponent(\'console.log("started"); await new Promise(()=>{})\'); void import(url); await new Promise(resolve=>setTimeout(resolve,20)); await import(url)')
  assert.equal(result.code,13)
  assert.equal(result.stdout,'started\n')
  assert.match(result.stderr,/unsettled top-level await/i)
})

test('floating CommonJS imports retain loading and timers, not unresolved evaluation',async()=>{
  for(const source of [
    'console.log("dependency"); await new Promise(()=>{})',
    'await new Promise(resolve=>setTimeout(resolve,20)); console.log("dependency")',
  ]){
    const result=await run(`void import(${JSON.stringify('data:text/javascript,'+encodeURIComponent(source))}); console.log("entry")`,'commonjs')
    assert.deepEqual(result,{code:0,signal:null,stdout:'entry\ndependency\n',stderr:''})
  }
})

test('file-URL imports have the same evaluation lifetime as path imports',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'container-file-url-control-'))
  for(const [name,source,code,stdout] of [
    ['pending.mjs','console.log("started"); await new Promise(()=>{})',13,'started\n'],
    ['resolved.mjs','await new Promise(resolve=>setTimeout(resolve,20)); console.log("resolved")',0,'resolved\n'],
  ]){
    const path=join(directory,name)
    await writeFile(path,source,{flag:'wx'})
    const result=await run(`await import(${JSON.stringify(pathToFileURL(path).href)})`)
    assert.equal(result.code,code)
    assert.equal(result.stdout,stdout)
    assert.equal(/unsettled top-level await/i.test(result.stderr),code===13)
  }
})
