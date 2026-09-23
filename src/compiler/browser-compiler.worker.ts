import {createCompilerFilesystem} from './compiler-workspace'
import path from 'path-browserify'

const scope=globalThis as any
const pending=new Map<number,{resolve(value:any):void;reject(error:Error):void}>()
let sequence=0,started=false,syncBytes=0,reading=false
let remainder=new Uint8Array()
function call(op:string,args:unknown[]):Promise<any>{
  if(pending.size>=64)return Promise.reject(Error('Compiler transport queue full'))
  return new Promise((resolve,reject)=>{
    const id=++sequence;pending.set(id,{resolve,reject});scope.postMessage({type:'rpc',id,op,args})
  })
}
const workspace=createCompilerFilesystem(call)
scope.fs={...workspace,
  writeSync(fd:number,bytes:Uint8Array){
    if(fd!==2||bytes.length>65536||(syncBytes+=bytes.length)>65536)throw Error('Unsupported synchronous compiler output')
    scope.postMessage({type:'sync-stderr',bytes:new Uint8Array(bytes)});return bytes.length
  },
  write(fd:number,buffer:Uint8Array,offset:number,length:number,position:number|null,callback:Function){
    if(fd!==1&&fd!==2)return workspace.write(fd,buffer,offset,length,position,callback as any)
    const count=Math.min(length,65536)
    call(fd===1?'stdio.stdout':'stdio.stderr',[buffer.slice(offset,offset+count)]).then(()=>callback(null,count),error=>callback(error))
  },
  read(fd:number,buffer:Uint8Array,offset:number,length:number,position:number|null,callback:Function){
    if(fd!==0)return workspace.read(fd,buffer,offset,length,position,callback as any)
    if(reading){callback(Error('Concurrent compiler stdin reads'));return}
    reading=true
    ;(async()=>{
      if(length===0)return 0
      if(!remainder.length){const chunk=await call('stdio.read',[]);if(chunk===null)return 0;remainder=chunk}
      const count=Math.min(length,remainder.length)
      buffer.set(remainder.subarray(0,count),offset);remainder=remainder.slice(count);return count
    })().then(count=>{reading=false;callback(null,count)},error=>{reading=false;callback(error)})
  },
}
scope.path=path
scope.onmessage=async({data}:MessageEvent)=>{
  if(data.type==='reply'){
    const waiter=pending.get(data.id)
    if(!waiter)return
    pending.delete(data.id)
    data.error?waiter.reject(Object.assign(Error(data.error.message),{code:data.error.code})):waiter.resolve(data.value)
    return
  }
  if(data.type!=='start'||started)return
  started=true
  try{
    scope.process={getuid:()=>0,getgid:()=>0,geteuid:()=>0,getegid:()=>0,getgroups:()=>[],pid:1,ppid:0,umask:()=>0,cwd:()=>data.cwd,chdir(){throw Error('Compiler chdir unsupported')}}
    // This classic worker loads only the trusted runtime chosen by its owner.
    if(typeof scope.Go!=='function'){
      if(typeof data.runtimeURL!=='string')throw Error('Missing trusted compiler runtime')
      importScripts(data.runtimeURL)
    }
    const go=new scope.Go();go.argv=data.argv;go.env=data.env
    let code=0;go.exit=(value:number)=>{code=value}
    const result=await WebAssembly.instantiate(data.bytes,go.importObject)
    await go.run((result as WebAssembly.WebAssemblyInstantiatedSource).instance)
    scope.postMessage({type:'exit',code})
  }catch(error){scope.postMessage({type:'error',error:String(error)})}
}
