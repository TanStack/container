import {spawn} from 'node:child_process'
import assert from 'node:assert/strict'
import {stdinLifecycleSources} from '../tests/fixtures/native-stdin-lifecycle.mjs'

const results=[]
for(const [name,source] of Object.entries(stdinLifecycleSources)){
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',source],{stdio:['pipe','pipe','pipe']})
    let stdout='',stderr='',sent=false
    const deadline=setTimeout(()=>{child.kill();reject(Error(name+' did not exit with open stdin'))},4000)
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')reject(error)})
    child.stdout.on('data',bytes=>{
      stdout+=String(bytes)
      if(name==='resumed'&&!sent&&stdout.includes('ready\n')){sent=true;child.stdin.end('payload')}
    })
    child.stderr.on('data',bytes=>{stderr+=String(bytes)})
    child.once('error',reject)
    child.once('close',(code,signal)=>{clearTimeout(deadline);resolve({name,code,signal,stdout,stderr})})
  })
  assert.deepEqual(result,{name,code:0,signal:null,stdout:name==='resumed'?'ready\npayload':'ready\n',stderr:''})
  results.push(result)
}
console.log(JSON.stringify({node:process.version,results}))
