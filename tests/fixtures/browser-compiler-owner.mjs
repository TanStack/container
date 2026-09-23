import {WorkspaceFiles} from '../../src/sandbox/files'
import {WorkspaceFileSessions} from '../../src/sandbox/workspace-file-sessions'
import {CompilerWorkspace} from '../../src/compiler/compiler-workspace'
import {encodeRequest,decodeResponse} from './compiler-protocol.mjs'

export async function runCompilerWorkflow(){
  const files=new WorkspaceFiles({'/workspace/entry.ts':'import { answer } from "./answer"; export { answer };','/workspace/answer.ts':'export const answer: number = 42'},1024*1024,64)
  const sessions=new WorkspaceFileSessions(files)
  const bytes=new Uint8Array(await(await fetch('/compiler.wasm')).arrayBuffer())
  const builds=[]
  try{
    for(const answer of [42,43]){
      files.writeFileSync('/workspace/answer.ts',new TextEncoder().encode(`export const answer: number = ${answer}`))
      const workspace=new CompilerWorkspace(sessions,true)
      const worker=new Worker('/worker.js')
      const logs=[]
      let timer,closed=false
      try{
        const result=await new Promise((resolve,reject)=>{
          timer=setTimeout(()=>reject(Error('Compiler build exceeded 15 seconds')),15000)
          worker.onerror=event=>reject(Error(event.message))
          worker.onmessage=async({data:message})=>{
            if(closed)return
            if(message.type==='rpc'){
              let value,error
              try{value=await workspace.call(message.op,message.args)}catch(cause){error={code:cause.code,message:cause.message}}
              if(!closed)worker.postMessage({type:'reply',id:message.id,value,error})
            }else if(message.type==='output')logs.push(new TextDecoder().decode(message.bytes))
            else if(message.type==='exit')resolve(message)
            else if(message.type==='error')reject(Error(message.error))
          }
          worker.postMessage({type:'start',bytes})
        })
        if(result.code!==0)throw Error('Compiler exited '+result.code+': '+logs.join(''))
        const output=new TextDecoder().decode(files.readFileSync('/workspace/out/bundle.js'))
        const url=URL.createObjectURL(new Blob([output],{type:'text/javascript'}))
        let actual
        try{actual=(await import(url)).answer}finally{URL.revokeObjectURL(url)}
        builds.push({...result,actual,output,logs})
      }finally{closed=true;clearTimeout(timer);workspace.close();worker.terminate()}
      builds.at(-1).resources={descriptors:sessions.descriptors,sessions:sessions.size}
    }
    return {builds,actualSafari:false,scope:'Two fresh CLI workers, not incremental service rebuilds or Vite'}
  }finally{sessions.close();files.close()}
}

export async function runCompilerServiceWorkflow(){
  const files=new WorkspaceFiles({'/workspace/entry.ts':'import { answer } from "./answer"; export { answer };','/workspace/answer.ts':'export const answer: number = 42'},1024*1024,64)
  const sessions=new WorkspaceFileSessions(files),workspace=new CompilerWorkspace(sessions,true)
  const worker=new Worker('/worker.js'),waiters=new Map()
  let closed=false,buffer=new Uint8Array(),received=0,handshake=false,sequence=0,timer
  const logs=[]
  let readyResolve,readyReject
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject})
  const fail=error=>{readyReject(error);for(const waiter of waiters.values())waiter.reject(error);waiters.clear()}
  worker.onerror=event=>fail(Error(event.message))
  worker.onmessage=async({data:message})=>{
    if(closed)return
    if(message.type==='rpc'){
      let value,error
      try{value=await workspace.call(message.op,message.args)}catch(cause){error={code:cause.code,message:cause.message}}
      if(!closed)worker.postMessage({type:'reply',id:message.id,value,error})
    }else if(message.type==='output'&&message.fd===1){
      try{
        received+=message.bytes.length;if(received>1024*1024)throw Error('Compiler service output limit')
        const combined=new Uint8Array(buffer.length+message.bytes.length);combined.set(buffer);combined.set(message.bytes,buffer.length);buffer=combined
        while(buffer.length>=4){
          const size=new DataView(buffer.buffer,buffer.byteOffset,4).getUint32(0,true)
          if(size>1024*1024)throw Error('Compiler service packet limit')
          if(buffer.length<size+4)break
          const packet=buffer.slice(4,size+4);buffer=buffer.slice(size+4)
          if(!handshake){
            if(new TextDecoder().decode(packet)!=='0.28.2')throw Error('Compiler version mismatch')
            handshake=true;readyResolve()
          }else{
            const response=decodeResponse(packet),waiter=waiters.get(response.id)
            if(!waiter)throw Error('Unexpected compiler service response')
            waiters.delete(response.id);waiter.resolve(response.value)
          }
        }
      }catch(error){fail(error)}
    }else if(message.type==='output'&&message.fd===2)logs.push(new TextDecoder().decode(message.bytes))
    else if(message.type==='error'||message.type==='exit')fail(Error(message.error??'Unexpected service exit'))
  }
  const builds=[]
  try{
    timer=setTimeout(()=>fail(Error('Service workflow exceeded 15 seconds')),15000)
    const bytes=new Uint8Array(await(await fetch('/compiler.wasm')).arrayBuffer())
    worker.postMessage({type:'start',service:true,bytes})
    await ready
    for(const answer of [42,43]){
      files.writeFileSync('/workspace/answer.ts',new TextEncoder().encode(`export const answer: number = ${answer}`))
      const id=++sequence
      const response=await new Promise((resolve,reject)=>{
        waiters.set(id,{resolve,reject})
        worker.postMessage({type:'stdin',bytes:encodeRequest(id,{command:'build',key:id,entries:[['','entry.ts']],flags:['--bundle','--format=esm','--outfile=/workspace/out/bundle.js'],write:true,stdinContents:null,stdinResolveDir:null,absWorkingDir:'/workspace',nodePaths:[],context:false})})
      })
      if(response.errors?.length)throw Error('Compiler build errors: '+JSON.stringify(response.errors))
      const output=new TextDecoder().decode(files.readFileSync('/workspace/out/bundle.js'))
      const url=URL.createObjectURL(new Blob([output],{type:'text/javascript'}))
      let actual
      try{actual=(await import(url)).answer}finally{URL.revokeObjectURL(url)}
      builds.push({response,output,actual})
    }
    workspace.close()
    return {builds,logs,workerCount:1,handshake,pending:waiters.size,resources:{descriptors:sessions.descriptors,sessions:sessions.size},scope:'Two build packets in one service worker, not incremental context or Vite',actualSafari:false}
  }finally{closed=true;clearTimeout(timer);workspace.close();worker.terminate();sessions.close();files.close()}
}
