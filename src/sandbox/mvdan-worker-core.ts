import type {ProcessLifetime} from './execution-budget'

export interface MvdanWorkerOptions {
  assetBaseURL?:string
  script:string
  timeoutMs:number
  cwd:string
  env:Record<string,string>
  shellState?:string
  signal?:AbortSignal
  lifetime?:ProcessLifetime
  call(method:string,args:any[]):Promise<any>
  readStdin():Promise<Uint8Array|null>
  writeStdout(bytes:Uint8Array):Promise<void>
  writeStderr(bytes:Uint8Array):Promise<void>
}

/** Share shell RPC behavior with runtimes that supply their own worker URL. */
export function runMvdanWorkerWithFactory(options:MvdanWorkerOptions,createWorker:()=>Worker):Promise<{code:number;error:string;cwd?:string;shellState?:string}>{
  const {assetBaseURL,script,timeoutMs,cwd,env,shellState,signal,lifetime='bounded'}=options
  const aborted=()=>Object.assign(new Error('Shell execution aborted'),{name:'AbortError'})
  if(signal?.aborted)return Promise.reject(aborted())
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)return Promise.reject(Error('Invalid shell timeout'))
  const worker=createWorker()
  return new Promise((resolve,reject)=>{
    let finished=false,inflight=0
    const finish=(error?:Error,result?:{code:number;error:string;cwd?:string;shellState?:string})=>{
      if(finished)return
      finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate()
      error?reject(error):resolve(result!)
    }
    const abort=()=>finish(aborted())
    const timer=lifetime==='bounded'?setTimeout(()=>finish(Error('Shell execution timed out')),timeoutMs):undefined
    signal?.addEventListener('abort',abort,{once:true})
    worker.onerror=event=>finish(Error(event.error instanceof Error?event.error.stack??event.error.message:
      event.message||`Shell worker failed at ${event.filename}:${event.lineno}:${event.colno}`))
    worker.onmessage=async({data})=>{
      if(finished)return
      if(data.ready){worker.postMessage({run:true,script,timeoutMs:lifetime==='bounded'?timeoutMs:0,cwd,env,shellState,streaming:true});return}
      if(data.error){finish(Error(data.error));return}
      if(data.result){finish(undefined,data.result);return}
      if(!Number.isSafeInteger(data.id)||typeof data.method!=='string'||!Array.isArray(data.args)||++inflight>32){finish(Error('Invalid shell transport request'));return}
      try{
        let value:any
        if(data.method==='stdio.read'){
          value=await options.readStdin()
          if(value!==null&&(!(value instanceof Uint8Array)||value.byteLength===0||value.byteLength>65536))throw Error('Invalid shell stdin chunk')
        }else if(data.method==='stdio.stdout'||data.method==='stdio.stderr'){
          const bytes=data.args[0]
          if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)throw Error('Invalid shell output chunk')
          await (data.method==='stdio.stdout'?options.writeStdout(bytes):options.writeStderr(bytes))
        }else value=await options.call(data.method,data.args)
        if(!finished)worker.postMessage({reply:data.id,value})
      }catch(error){
        const code=error&&typeof error==='object'&&'code' in error?String(error.code):undefined
        if(!finished)worker.postMessage({reply:data.id,error:String(error),code})
      }finally{inflight--}
    }
    if(signal?.aborted){abort();return}
    worker.postMessage({init:true,assetBaseURL})
  })
}
