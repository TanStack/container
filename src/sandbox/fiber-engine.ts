import type {QuickJSAsyncWASMModule,QuickJSContext,QuickJSHandle} from 'quickjs-emscripten-core'
import {runtimeAssetURL} from './runtime-assets'
import {ThreadGroupMailbox} from './thread-group-mailbox'
import type {TaskScheduler} from './task-scheduler'
import {sharedMemoryPerEngineLimits} from './kernel-limits'

export type KernelFiber={step():number;status():number;deliver(value:number):boolean;cancel():boolean;takeResult():ReturnType<QuickJSContext['evalCode']>;dispose():void;atomicWait?():number|undefined;atomicReady?():boolean}
const atomicWakeups=new Set<()=>void>()
export type FiberContext=QuickJSContext&{
  initializeFiber(initializer:QuickJSHandle):ReturnType<QuickJSContext['evalCode']>
  startFiberEval(source:string,filename:string,flags?:number):KernelFiber
  startFiberCall(fn:QuickJSHandle):KernelFiber
}
const engines=new Map<string,{maxBytes:number;growthReservation:boolean;promise:Promise<QuickJSAsyncWASMModule>}>()
/** One engine per WASM mode in this kernel worker, each with its own budget. */
export function getFiberEngine(assetBaseURL?:string,guestWasm=false,maxBytes=16*1024*1024,growthReservation=false){
  sharedMemoryPerEngineLimits({maxBytes,growthReservation},true)
  const base=runtimeAssetURL(`quickjs-als-asyncify${guestWasm?'-wasm':''}-atomics-fibers-shared-storage/`,assetBaseURL).href
  let pending=engines.get(base)
  if(pending&&(pending.maxBytes!==maxBytes||pending.growthReservation!==growthReservation))throw Error('Shared memory policy is already fixed for this engine')
  if(!pending){
    const promise=(async()=>{
      const [core,loader,ffi]=await Promise.all(['core.mjs','engine.mjs','ffi.mjs'].map(file=>import(/* @vite-ignore */new URL(file,base).href)))
      const bytes=await(await fetch(new URL('engine.wasm',base))).arrayBuffer()
      const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>ffi.QuickJSAsyncFFI,importModuleLoader:async()=>()=>loader.default({wasmBinary:bytes})}) as QuickJSAsyncWASMModule&{configureSharedStorage(maxBytes:number,growthReservation?:boolean):void}
      engine.configureSharedStorage(maxBytes,growthReservation)
      return engine
    })()
    pending={maxBytes,growthReservation,promise}
    engines.set(base,pending)
    promise.catch(()=>{if(engines.get(base)===pending)engines.delete(base)})
  }
  return pending.promise
}

/** The experimental wait hook only supplies plain delay data. Completion never
 * enters the engine; the owning process resumes at its next scheduler boundary. */
export async function runKernelFiber(fiber:KernelFiber,options:{scheduler:TaskScheduler;signal:AbortSignal;expired:()=>boolean;takeWait:()=>number;waitTimeout?:()=>number|undefined;onStep?:(durationMs:number,status:number|undefined)=>void}){
  const mailbox=new ThreadGroupMailbox<number,string>(1),identity=mailbox.createTask(1)
  let transferred=false
  let failed=false,primary:unknown
  const step=()=>{
    let status:number|undefined
    const observer=options.onStep
    if(observer){
      const started=performance.now()
      try{status=fiber.step()}finally{
        // Observe only the synchronous step, including failed cleanup steps.
        // Diagnostic callbacks must not replace the execution result or error.
        const duration=performance.now()-started
        try{observer(duration,status)}catch{}
      }
    }else status=fiber.step()
    for(const wake of atomicWakeups)wake()
    return status
  }
  try{
    if(options.signal.aborted||options.expired())fiber.cancel()
    let status=step()
    while(status===1||status===3){
      if(status===3){
        // A fairness pause has no guest timer or delivery value. Keep the
        // caller's EngineAccess lock while another host task can advance peers.
        if(!options.signal.aborted&&!options.expired())await options.scheduler.checkpoint()
        if(options.signal.aborted||options.expired())fiber.cancel()
        status=step()
        continue
      }
      const atomicTimeout=fiber.atomicWait?.()
      if(atomicTimeout!==undefined){
        const deadline=performance.now()+atomicTimeout,wake=()=>options.scheduler.wake()
        atomicWakeups.add(wake);options.signal.addEventListener('abort',wake,{once:true})
        try{
          while(!fiber.atomicReady?.()){
            if(options.signal.aborted||options.expired()){fiber.cancel();break}
            const remaining=deadline-performance.now()
            if(remaining<=0){fiber.deliver(2);break}
            const timeout=Math.min(remaining,options.waitTimeout?.()??Infinity,2147483647)
            await options.scheduler.wait(false,Number.isFinite(timeout)?timeout:undefined)
          }
          if(options.signal.aborted||options.expired())fiber.cancel()
          status=step()
        }finally{atomicWakeups.delete(wake);options.signal.removeEventListener('abort',wake)}
        continue
      }
      const delay=options.takeWait(),request=mailbox.park(identity)
      const cancel=()=>{mailbox.cancel(identity,'Execution cancelled');options.scheduler.wake()}
      const timer=setTimeout(()=>{mailbox.deliver(request,{ok:true,value:0});options.scheduler.wake()},delay)
      options.signal.addEventListener('abort',cancel,{once:true})
      try{
        let completion:ReturnType<typeof mailbox.consume>
        do{
          if(options.signal.aborted||options.expired())cancel()
          completion=mailbox.consume(identity)
          if(!completion)await options.scheduler.wait(false,options.waitTimeout?.())
        }while(!completion)
        if(completion?.kind==='result'&&completion.result.ok)fiber.deliver(completion.result.value)
        else fiber.cancel()
        status=step()
        mailbox.acknowledgeUnwind(request)
      }finally{clearTimeout(timer);options.signal.removeEventListener('abort',cancel)}
    }
    if(status!==2)throw Error('Fiber did not finish at a scheduler boundary')
    const result=fiber.takeResult();transferred=true;return result
  }catch(error){
    failed=true;primary=error;throw error
  }finally{
    const cleanupErrors:unknown[]=[]
    const cleanup=(action:()=>void)=>{try{action()}catch(error){cleanupErrors.push(error)}}
    if(!transferred){
      cleanup(()=>{fiber.cancel()})
      cleanup(()=>{step()})
      cleanup(()=>{if(fiber.status()===2)fiber.takeResult().dispose()})
    }
    cleanup(()=>{fiber.dispose()})
    if(cleanupErrors.length){
      const errors=failed?[primary,...cleanupErrors]:cleanupErrors
      if(!failed&&errors.length===1)throw errors[0]
      const describe=(error:unknown)=>error instanceof Error?error.message:String(error)
      const aggregate=new AggregateError(errors,`Fiber ${failed?'execution and cleanup':'cleanup'} failed: ${errors.map(describe).join('; ')}`,{cause:failed?primary:cleanupErrors[0]})
      aggregate.stack=[aggregate.stack,...errors.map((error,index)=>`Failure ${index+1}: ${error instanceof Error?(error.stack??describe(error)):describe(error)}`)].join('\n')
      throw aggregate
    }
  }
}
