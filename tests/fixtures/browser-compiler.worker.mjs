import {createCompilerFilesystem} from '../../src/compiler/compiler-workspace'
import path from 'path-browserify'

const pending=new Map()
let sequence=0,outputBytes=0,started=false
let readWaiter,inputBytes=0
const input=[]
function consume(){
  if(!readWaiter||!input.length)return
  const {buffer,offset,length,callback}=readWaiter;readWaiter=undefined
  const chunk=input[0],count=Math.min(length,chunk.length)
  buffer.set(chunk.subarray(0,count),offset);inputBytes-=count
  if(count===chunk.length)input.shift();else input[0]=chunk.subarray(count)
  callback(null,count)
}
const workspace=createCompilerFilesystem((op,args)=>new Promise((resolve,reject)=>{
  if(pending.size>=64)return reject(Error('Filesystem queue limit'))
  const id=++sequence;pending.set(id,{resolve,reject});postMessage({type:'rpc',id,op,args})
}))
globalThis.fs={...workspace,
  writeSync(fd,bytes){
    if(fd!==1&&fd!==2)throw Error('Unsupported synchronous write')
    outputBytes+=bytes.length;if(outputBytes>1024*1024)throw Error('Compiler output limit')
    postMessage({type:'output',fd,bytes:new Uint8Array(bytes)});return bytes.length
  },
  write(fd,buffer,offset,length,position,callback){
    if(fd!==1&&fd!==2)return workspace.write(fd,buffer,offset,length,position,callback)
    try{callback(null,this.writeSync(fd,buffer.subarray(offset,offset+length)))}catch(error){callback(error)}
  },
  read(fd,buffer,offset,length,position,callback){
    if(fd===0){if(readWaiter)throw Error('Concurrent stdin reads');readWaiter={buffer,offset,length,callback};consume();return}
    workspace.read(fd,buffer,offset,length,position,callback)
  },
}
globalThis.process={getuid:()=>0,getgid:()=>0,geteuid:()=>0,getegid:()=>0,getgroups:()=>[],pid:1,ppid:0,umask:()=>0,cwd:()=>'/workspace',chdir(){throw Error('Working directory changes unsupported')}}
globalThis.path=path
onmessage=async({data:message})=>{
  if(message.type==='stdin'){
    inputBytes+=message.bytes.length;if(inputBytes>1024*1024)throw Error('Compiler stdin limit')
    input.push(message.bytes);consume();return
  }
  if(message.type==='reply'){
    const call=pending.get(message.id);if(!call)throw Error('Unknown filesystem reply')
    pending.delete(message.id)
    message.error?call.reject(Object.assign(Error(message.error.message),{code:message.error.code})):call.resolve(message.value)
    return
  }
  if(message.type!=='start'||started)return
  started=true
  try{
    importScripts('/wasm_exec.js')
    const go=new Go()
    go.argv=message.service?['esbuild','--service=0.28.2']:['esbuild','/workspace/entry.ts','--bundle','--format=esm','--outfile=/workspace/out/bundle.js']
    go.env={PWD:'/workspace',TMPDIR:'/tmp'}
    let code=0;go.exit=value=>{code=value}
    const result=await WebAssembly.instantiate(message.bytes,go.importObject)
    await go.run(result.instance)
    postMessage({type:'exit',code,pending:pending.size,memoryBytes:result.instance.exports.mem.buffer.byteLength})
  }catch(error){postMessage({type:'error',error:String(error)})}
}
