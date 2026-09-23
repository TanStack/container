import {resolveRuntimeAssetBase,runtimeAssetURL} from './runtime-assets'
const scope=globalThis as any
let next=0
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
function request(method:string,args:unknown[]){
  if(pending.size>=32)return Promise.reject(Error('Shell filesystem request limit exceeded'))
  return new Promise<any>((resolve,reject)=>{
    const id=++next;pending.set(id,{resolve,reject});postMessage({id,method,args})
  })
}
const metadata=(path:string,s:any)=>({name:path.split('/').filter(Boolean).at(-1)??'/',size:s.size,mode:s.mode,isDir:s.kind==='directory'})
scope.shellReadStdin=()=>request('stdio.read',[])
scope.shellWriteStdout=(bytes:Uint8Array)=>request('stdio.stdout',[bytes])
scope.shellWriteStderr=(bytes:Uint8Array)=>request('stdio.stderr',[bytes])
scope.shellFS={
  open:(...args:unknown[])=>request('open',args),
  close:(fd:number)=>request('close',[fd]),
  read:(fd:number,length:number)=>request('read',[fd,length]),
  write:(fd:number,bytes:Uint8Array)=>request('write',[fd,bytes]),
  stat:async(path:string,follow:boolean)=>JSON.stringify(metadata(path,await request(follow?'stat':'lstat',[path]))),
  readdir:async(path:string)=>{
    const names:string[]=await request('readdir',[path])
    const entries=[]
    for(const name of names)entries.push(metadata(name,await request('stat',[path+'/'+name])))
    return JSON.stringify(entries)
  },
}
scope.shellSpawn=async(argsJSON:string,cwd:string,envJSON:string,read:()=>Promise<Uint8Array|null>,write:(bytes:Uint8Array)=>Promise<void>,stderr:(bytes:Uint8Array)=>Promise<void>,signal:AbortSignal)=>{
  const pid=await request('process.spawn',[JSON.parse(argsJSON),cwd,JSON.parse(envJSON)])
  let ended=false
  const abort=()=>{void request('process.kill',[pid]).catch(()=>{})}
  signal.addEventListener('abort',abort,{once:true})
  if(signal.aborted)abort()
  // Keep shell pipeline reads and process output pumping concurrent. Each
  // chunk waits for its receiver before another chunk is requested.
  void(async()=>{
    while(!ended){
      const bytes=await read()
      if(ended)return
      if(bytes===null){await request('process.end',[pid]);return}
      await request('process.write',[pid,bytes])
    }
  })().catch(()=>{if(!ended)abort()})
  try{
    for(;;){
      const event=await request('process.next',[pid])
      if(event===null)return 1
      if(event.type==='exit')return event.code??(event.signal==='SIGKILL'?137:143)
      await (event.type==='stdout'?write:stderr)(event.bytes)
    }
  }catch(error){
    // A closed pipeline reader ends its writer, not the shell interpreter.
    // Return a failing command status so mvdan can apply pipefail normally.
    if(error&&typeof error==='object'&&'code' in error&&error.code==='EPIPE')return 141
    throw error
  }finally{
    ended=true;signal.removeEventListener('abort',abort)
    await request('process.dispose',[pid])
  }
}
let initialized=false
self.onmessage=async({data})=>{
  if(data.init){
    try{
      if(initialized)throw Error('Shell already initialized')
      initialized=true
      await initialize(resolveRuntimeAssetBase(data.assetBaseURL))
    }catch(error){postMessage({error:String(error)})}
    return
  }
  if(data.reply!==undefined){
    const call=pending.get(data.reply);if(!call)return
    pending.delete(data.reply);data.error?call.reject(Object.assign(Error(data.error),{code:data.code})):call.resolve(data.value)
    return
  }
  if(data.run){
    try{postMessage({result:await scope.goShell(data.script,data.timeoutMs,data.cwd,JSON.stringify(data.env),data.stdin,data.streaming===true)})}
    catch(error){postMessage({error:String(error)})}
  }
}
async function initialize(assetBaseURL:string){
  const url=runtimeAssetURL('mvdan-shell/wasm_exec.js',assetBaseURL).href
  await import(/* @vite-ignore */url)
  const go=new scope.Go()
  const response=await fetch(runtimeAssetURL('mvdan-shell/shell.wasm',assetBaseURL))
  if(!response.ok)throw Error('Shell asset download failed: '+response.status)
  const {instance}=await WebAssembly.instantiateStreaming(response,go.importObject)
  void go.run(instance).catch((error:unknown)=>postMessage({error:String(error)}))
  postMessage({ready:true})
}
