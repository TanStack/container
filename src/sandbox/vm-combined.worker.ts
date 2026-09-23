import type { QuickJSDeferredPromise, QuickJSAsyncRuntime, ExecutePendingJobsResult } from 'quickjs-emscripten-core'
import ASYNCIFY from '@jitl/quickjs-wasmfile-release-asyncify'
import alsBootstrap from './engine-als-bootstrap.js?raw'
import taskQueueBootstrap from './guest-task-queue.js?raw'

type AsyncRuntime = QuickJSAsyncRuntime & {
  executePendingJobsAsync(count: number): Promise<ExecutePendingJobsResult>
}

// One owner enters WASM. Message/timer callbacks queue completions only, never
// touch VM handles while an Asyncify stack is suspended.
self.onmessage = event => {
  if (event.data.type !== 'execute') return
  // Completion means handles and timers have been released. The host can
  // terminate this worker as soon as it receives the notification.
  execute(event.data).then(()=>self.postMessage({type:'done'}),error=>self.postMessage({type:'error',error:String(error)}))
}
async function execute({code,env,argv,maxBytes,timeoutMs,webAPIs}: {code:string;env:Record<string,string>;argv:string[];maxBytes:number;timeoutMs:number;webAPIs:boolean}) {
  const coreURL = new URL('/quickjs-als-asyncify/core.mjs',location.href).href
  const core: typeof import('quickjs-emscripten-core') = await import(/* @vite-ignore */ coreURL)
  const engineURL = new URL('/quickjs-als-asyncify/engine.mjs',location.href).href
  const ffiURL = new URL('/quickjs-als-asyncify/ffi.mjs',location.href).href
  const engine = await core.newQuickJSAsyncWASMModuleFromVariant(core.newVariant({
    ...ASYNCIFY, importModuleLoader:async()=>(await import(/* @vite-ignore */ engineURL)).default,
    importFFI:async()=>(await import(/* @vite-ignore */ ffiURL)).QuickJSAsyncFFI,
  },{wasmLocation:new URL('/quickjs-als-asyncify/engine.wasm',location.href).href}))
  const runtime = engine.newRuntime() as AsyncRuntime
  runtime.setMemoryLimit(maxBytes)
  runtime.setMaxStackSize(512*1024)
  const deadline = performance.now()+timeoutMs
  runtime.setInterruptHandler(()=>performance.now()>deadline)
  const context = runtime.newContext()
  let nextId = 0
  let wake: (()=>void) | undefined
  const syncCalls = new Map<number,{resolve(value:string):void;reject(error:Error):void}>()
  const asyncCalls = new Map<number,QuickJSDeferredPromise>()
  const timers = new Map<number,ReturnType<typeof setTimeout>>()
  const ready: Array<()=>void> = []
  const queue = (operation:()=>void) => { ready.push(operation); wake?.() }
  const settle = (id:number,value:string,error?:string) => {
    const deferred = asyncCalls.get(id)
    if (!deferred) return
    asyncCalls.delete(id)
    const result = error ? context.newError(error) : context.newString(value)
    try { error ? deferred.reject(result) : deferred.resolve(result) }
    finally { result.dispose(); deferred.dispose() }
  }
  self.onmessage = event => {
    if (event.data.type!=='fs-result') return
    const {id,value,error}=event.data
    const call=syncCalls.get(id)
    if (call) {
      syncCalls.delete(id)
      // This resolves the host-side suspension, not a guest promise.
      error ? call.reject(new Error(error)) : call.resolve(value)
    } else queue(()=>settle(id,value,error))
  }
  const expose = (name:string,callback:Parameters<typeof context.newFunction>[1]) => {
    const handle=context.newFunction(name,callback)
    context.setProp(context.global,name,handle)
    handle.dispose()
  }
  try {
    context.unwrapResult(context.evalCode(alsBootstrap)).dispose()
    context.unwrapResult(context.evalCode(taskQueueBootstrap)).dispose()
    const sync=context.newAsyncifiedFunction('__syncFS',async(method,args)=>{
      const id=++nextId
      const methodText=context.getString(method), argsText=context.getString(args)
      const value=await new Promise<string>((resolve,reject)=>{
        syncCalls.set(id,{resolve,reject})
        self.postMessage({type:'fs',id,method:methodText,args:argsText})
      })
      if(performance.now()>deadline)throw new Error('Execution timed out')
      return context.newString(value)
    })
    context.setProp(context.global,'__syncFS',sync)
    sync.dispose()
    expose('__asyncFS',(method,args)=>{
      if(asyncCalls.size>=128)throw new Error('Too many pending calls')
      const id=++nextId,deferred=context.newPromise()
      asyncCalls.set(id,deferred)
      self.postMessage({type:'fs',id,method:context.getString(method),args:context.getString(args)})
      return deferred.handle.dup()
    })
    expose('__timer',delay=>{
      if(asyncCalls.size>=128)throw new Error('Too many pending calls')
      const id=++nextId,deferred=context.newPromise()
      asyncCalls.set(id,deferred)
      const idValue=context.newNumber(id)
      context.setProp(deferred.handle,'timerId',idValue)
      idValue.dispose()
      timers.set(id,setTimeout(()=>{
        timers.delete(id)
        queue(()=>settle(id,'null'))
      },Math.max(0,Math.min(context.getNumber(delay)||0,2147483647))))
      return deferred.handle.dup()
    })
    expose('__cancelTimer',value=>{
      const id=context.getNumber(value)
      clearTimeout(timers.get(id));timers.delete(id)
      asyncCalls.get(id)?.dispose();asyncCalls.delete(id)
    })
    expose('__print',(level,text)=>{
      self.postMessage({type:'output',level:context.getString(level),text:context.getString(text)})
    })
    context.unwrapResult(context.evalCode(`(()=>{
      const sync=__syncFS,async=__asyncFS,timer=__timer,cancel=__cancelTimer,print=__print,ALS=__engineAsyncLocalStorage;
      delete globalThis.__syncFS;delete globalThis.__asyncFS;delete globalThis.__timer;delete globalThis.__cancelTimer;delete globalThis.__print;delete globalThis.__engineAsyncLocalStorage;
      const encode=value=>typeof value==='string'?value:value instanceof Uint8Array?{bytes:Array.from(value)}:(()=>{throw new TypeError('Expected string or Uint8Array')})();
      const decode=value=>value?.bytes?new Uint8Array(value.bytes):value;
      const stat=value=>({...value,isFile:()=>value.kind==='file',isDirectory:()=>value.kind==='directory'});
      const syncCall=(method,args)=>JSON.parse(sync(method,JSON.stringify(args)));
      const asyncCall=async(method,args)=>JSON.parse(await async(method,JSON.stringify(args)));
      const fsSync={
        readFile:(...args)=>decode(syncCall('readFile',args)),
        writeFile:(path,value,options)=>syncCall('writeFile',[path,encode(value),options]),
        readdir:(...args)=>syncCall('readdir',args),stat:path=>stat(syncCall('stat',[path])),
        exists:path=>syncCall('exists',[path]),realpath:path=>syncCall('realpath',[path])
      };
      const fs={
        readFile:async(...args)=>decode(await asyncCall('readFile',args)),
        writeFile:(path,value,options)=>asyncCall('writeFile',[path,encode(value),options]),
        readdir:(...args)=>asyncCall('readdir',args),stat:async path=>stat(await asyncCall('stat',[path]))
      };
      for(const method of ['mkdir','rmdir','rm','unlink','rename','copyFile','truncate','chmod','access','realpath','symlink','readlink','lstat']){fsSync[method]=(...args)=>syncCall(method,args);fs[method]=(...args)=>asyncCall(method,args)}
      globalThis.__webContainerHost={fs,fsSync,AsyncLocalStorage:ALS,env:${JSON.stringify(env)},argv:${JSON.stringify(argv)}};
      globalThis.console=Object.fromEntries(['log','info','warn','error','debug'].map(level=>[level,(...args)=>print(level,args.map(x=>typeof x==='string'?x:x instanceof Error?x.message+'\\n'+x.stack:JSON.stringify(x)).join(' '))]));
      globalThis.queueMicrotask=callback=>{Promise.resolve().then(callback)};
      globalThis.setTimeout=(callback,delay=0,...args)=>{
        if(typeof callback!=='function')throw new TypeError('Expected callback');
        const p=timer(Number(delay));const invoke=ALS.bind(callback);p.then(()=>globalThis[Symbol.for('web-container:task-queue')].task(invoke,undefined,args));return p.timerId;
      };
      globalThis.clearTimeout=id=>cancel(Number(id));
    })()`)).dispose()
    if(webAPIs){
      const response=await fetch('/vm-web-apis/globals.js')
      if(!response.ok)throw new Error('Guest Web APIs are missing. Run npm run build:vm-web-apis.')
      const initialization=context.evalCode(await response.text(),'web-apis.js')
      if(initialization.error){const error=context.dump(initialization.error);initialization.dispose();throw new Error(`${error.message}\n${error.stack??''}`)}
      initialization.dispose()
    }
    const evaluation=await context.evalCodeAsync(code,'workspace.mjs',{type:'module'})
    if(evaluation.error){const error=context.dump(evaluation.error);evaluation.dispose();throw new Error(`${error?.message??JSON.stringify(error)}\n${error?.stack??''}`)}
    try {
      for(;;){
        if(performance.now()>deadline)throw new Error('Execution timed out')
        // Keep host completions outside unfinished guest checkpoints, even
        // when bounded job pumping yields back to the browser.
        if(!runtime.hasPendingJob()){
          const drained=await context.evalCodeAsync("globalThis[Symbol.for('web-container:task-queue')].drain()")
          context.unwrapResult(drained).dispose()
          if(!runtime.hasPendingJob())ready.shift()?.()
        }
        const jobs=await runtime.executePendingJobsAsync(50)
        if(jobs.error){const error=context.dump(jobs.error);jobs.dispose();throw new Error(`${error?.message??JSON.stringify(error)}\n${error?.stack??''}`)}
        jobs.dispose()
        if(!runtime.hasPendingJob()){
          const drained=await context.evalCodeAsync("globalThis[Symbol.for('web-container:task-queue')].drain()")
          context.unwrapResult(drained).dispose()
        }
        const state=context.getPromiseState(evaluation.value)
        if(state.type==='fulfilled'){if(!state.notAPromise)state.value.dispose();if(!runtime.hasPendingJob())break}
        if(state.type==='rejected'){const error=context.dump(state.error);state.error.dispose();throw new Error(`${error?.message??JSON.stringify(error)}\n${error?.stack??''}`)}
        await new Promise<void>(resolve=>{
          const timer=setTimeout(()=>{wake=undefined;resolve()},runtime.hasPendingJob()||ready.length?0:Math.max(1,deadline-performance.now()))
          wake=()=>{clearTimeout(timer);wake=undefined;resolve()}
        })
      }
    }finally{evaluation.dispose()}
  }finally{
    self.onmessage=null
    for(const timer of timers.values())clearTimeout(timer)
    for(const deferred of asyncCalls.values())deferred.dispose()
    context.dispose();runtime.dispose()
  }
}
