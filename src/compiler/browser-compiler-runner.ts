import {applyWasmMemoryPolicy} from './wasm-memory-policy'
import {EsbuildSessionMonitor} from './esbuild-session-monitor'

export interface BrowserCompilerOptions {
  /** Trusted owner factory for browser-compiler.worker.ts, never guest supplied. */
  createWorker():Worker
  /** Trusted, version-pinned Go runtime asset. This is executable owner code. */
  runtimeURL?:string
  bytes:Uint8Array
  maxMemoryPages:number
  argv:string[]
  cwd:string
  env:Record<string,string>
  /** Workflow deadline in bounded mode, per-protocol-request deadline in session mode. Neither measures CPU time. */
  timeoutMs:number
  lifetime?:'bounded'|'session'
  signal?:AbortSignal
  call(method:string,args:unknown[]):Promise<unknown>
  readStdin():Promise<Uint8Array|null>
  writeStdout(bytes:Uint8Array):Promise<void>
  writeStderr(bytes:Uint8Array):Promise<void>
}

/** Experimental transport only. Caller owns and closes the filesystem lease.
 * Bounds WASM linear memory, transport chunks and queued calls, not browser heap.
 * No kernel selection or SDK activation is implied by invoking this runner.
 */
export async function runBrowserCompiler(options:BrowserCompilerOptions):Promise<{code:number}>{
  const abortError=()=>Object.assign(Error('Compiler execution aborted'),{name:'AbortError'})
  if(options.signal?.aborted)throw abortError()
  if(options.lifetime!==undefined&&options.lifetime!=='bounded'&&options.lifetime!=='session')throw Error('Invalid compiler lifetime')
  if(options.lifetime==='session'&&(!options.argv.includes('--service=0.28.2')||options.argv.slice(1).some(arg=>arg!=='--service=0.28.2'&&arg!=='--ping')))throw Error('Session compiler requires the pinned service protocol')
  if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>2147483647)throw Error('Invalid compiler workflow deadline')
  const policy=applyWasmMemoryPolicy(options.bytes,options.maxMemoryPages)
  if(policy.originalMaxPages===null||policy.originalMaxPages>options.maxMemoryPages)throw Error('Compiler artifact must already have an explicit owner memory cap')
  const worker=options.createWorker()
  return new Promise((resolve,reject)=>{
    let finished=false,pending=0,syncBytes=0
    let monitor:EsbuildSessionMonitor|undefined
    const ids=new Set<number>()
    const finish=(error?:Error,code=0)=>{
      if(finished)return
      finished=true;clearTimeout(timer);monitor?.close();options.signal?.removeEventListener('abort',abort);worker.terminate()
      error?reject(error):resolve({code})
    }
    const abort=()=>finish(abortError())
    const timer=options.lifetime==='session'?undefined:setTimeout(()=>finish(Error('Compiler workflow deadline exceeded')),options.timeoutMs)
    if(options.lifetime==='session')monitor=new EsbuildSessionMonitor({startupMs:options.timeoutMs,requestMs:options.timeoutMs,maxPacketBytes:16*1024*1024,maxPending:64},error=>finish(error))
    options.signal?.addEventListener('abort',abort,{once:true})
    worker.onerror=event=>finish(Error(event.message))
    worker.onmessage=async({data})=>{
      if(finished)return
      if(data?.type==='exit'){if(!Number.isInteger(data.code))finish(Error('Invalid compiler exit'));else finish(undefined,data.code);return}
      if(data?.type==='error'){finish(Error(String(data.error)));return}
      if(data?.type==='sync-stderr'){
        if(!(data.bytes instanceof Uint8Array)||data.bytes.length>65536||(syncBytes+=data.bytes.length)>65536){finish(Error('Compiler synchronous output limit'));return}
        try{await options.writeStderr(data.bytes)}catch(error){finish(Error(String(error)))}
        return
      }
      if(data?.type!=='rpc'||!Number.isSafeInteger(data.id)||ids.has(data.id)||typeof data.op!=='string'||!Array.isArray(data.args)||pending>=64){finish(Error('Invalid compiler transport request'));return}
      pending++;ids.add(data.id)
      try{
        let value:unknown
        if(data.op==='stdio.read'){
          value=await options.readStdin()
          if(value!==null&&(!(value instanceof Uint8Array)||value.length===0||value.length>65536))throw Error('Invalid compiler stdin chunk')
          if(value!==null)monitor?.feedInput(value as Uint8Array)
        }else if(data.op==='stdio.stdout'||data.op==='stdio.stderr'){
          const bytes=data.args[0]
          if(!(bytes instanceof Uint8Array)||bytes.length>65536)throw Error('Invalid compiler output chunk')
          if(data.op==='stdio.stdout')monitor?.feedOutput(bytes)
          if(finished)return
          await (data.op==='stdio.stdout'?options.writeStdout(bytes):options.writeStderr(bytes))
        }else value=await options.call(data.op,data.args)
        if(!finished)worker.postMessage({type:'reply',id:data.id,value})
      }catch(error){
        if(!finished)worker.postMessage({type:'reply',id:data.id,error:{message:String(error),code:(error as {code?:string})?.code}})
      }finally{pending--;ids.delete(data.id)}
    }
    if(options.signal?.aborted){abort();return}
    try{worker.postMessage({type:'start',runtimeURL:options.runtimeURL,bytes:options.bytes,argv:options.argv,cwd:options.cwd,env:options.env})}
    catch(error){finish(Error(String(error)))}
  })
}
