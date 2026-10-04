const RUNNING=0,COMPLETE=1,FAILED=2,CLOSED=3
const field='nativeThreadCompletion'
const now=performance.now.bind(performance)

function isSharedLane(value){
  return value instanceof Int32Array&&value.length===1&&value.buffer instanceof SharedArrayBuffer
}

// Thread joins happen in WASM, but the upstream pool normally learns about an
// exited thread from a later message event. Share that completion directly so
// another synchronous native call can reuse it without yielding its caller.
export function createNativeWasiThreadPool({timeoutMs=1000}={}){
  if(!Number.isFinite(timeoutMs)||timeoutMs<0||timeoutMs>30000)
    throw RangeError('Native thread pool timeout must be between 0 and 30000 milliseconds')
  const changed=new Int32Array(new SharedArrayBuffer(4))
  const records=new WeakMap(),workers=new Set()
  let disposed=false,installed=false,allocations=0,reclaims=0
  const notify=()=>{Atomics.add(changed,0,1);Atomics.notify(changed,0)}
  const settle=(record,status)=>{
    if(record.active&&Atomics.compareExchange(record.active.state,0,RUNNING,status)===RUNNING)notify()
  }
  function connect(worker){
    if(disposed)throw Error('Native thread pool is disposed')
    if(records.has(worker))throw Error('Native thread worker is already connected')
    if(typeof worker?.postMessage!=='function'||typeof worker?.terminate!=='function')
      throw TypeError('Native thread pool requires a worker')
    const post=worker.postMessage,terminate=worker.terminate
    const record={active:undefined,closed:false}
    records.set(worker,record);workers.add(worker);allocations++
    Object.defineProperty(worker,'postMessage',{configurable:true,writable:true,value:function(message,...args){
      if(this!==worker)return Reflect.apply(post,this,[message,...args])
      if(disposed||record.closed)throw Error('Native thread worker is closed')
      const thread=message?.__emnapi__
      if(thread?.type==='start'){
        const tid=thread.payload?.tid
        if(!Number.isSafeInteger(tid)||tid<1||tid>0x7fffffff)throw TypeError('Invalid native thread identity')
        if(record.active&&Atomics.load(record.active.state,0)===RUNNING)
          throw Error('Cannot reuse a running native thread worker')
        const state=new Int32Array(new SharedArrayBuffer(4))
        record.active={tid,state}
        message={...message,__emnapi__:{...thread,payload:{...thread.payload,[field]:{tid,state,changed}}}}
      }
      try{return Reflect.apply(post,worker,[message,...args])}
      catch(error){settle(record,FAILED);throw error}
    }})
    Object.defineProperty(worker,'terminate',{configurable:true,writable:true,value:function(...args){
      if(this===worker&&!record.closed){
        record.closed=true;settle(record,CLOSED);workers.delete(worker);notify()
      }
      return Reflect.apply(terminate,this,args)
    }})
    const failed=()=>settle(record,FAILED)
    if(worker.addEventListener)worker.addEventListener('error',failed)
    else worker.on?.('error',failed)
    return worker
  }
  function install(manager){
    if(disposed)throw Error('Native thread pool is disposed')
    if(installed)throw Error('Native thread pool manager is already installed')
    if(typeof manager?.getNewWorker!=='function'||typeof manager?.cleanThread!=='function'||
      !Array.isArray(manager.unusedWorkers)||!manager.pthreads)
      throw TypeError('Unsupported native thread pool manager')
    installed=true
    const getNew=manager.getNewWorker,clean=manager.cleanThread
    const reap=()=>{
      for(const worker of Object.values(manager.pthreads)){
        const record=records.get(worker),active=record?.active
        if(!record?.closed&&active&&worker.__emnapi_tid===active.tid&&Atomics.load(active.state,0)===COMPLETE){
          Reflect.apply(clean,manager,[worker,active.tid,false]);reclaims++
        }
      }
    }
    manager.cleanThread=function(worker,tid,force){
      const record=records.get(worker)
      if(record){
        // An old cleanup message can arrive after a synchronous reclaim and
        // reassignment. It must never free the worker's new running lease.
        if(worker.__emnapi_tid!==tid||record.active?.tid!==tid)return
        if(!force&&Atomics.load(record.active.state,0)!==COMPLETE)return
      }
      return Reflect.apply(clean,this,[worker,tid,force])
    }
    manager.getNewWorker=function(...args){
      if(disposed)throw Error('Native thread pool is disposed')
      const deadline=now()+timeoutMs
      while(true){
        const version=Atomics.load(changed,0)
        reap()
        if(manager.unusedWorkers.length)return Reflect.apply(getNew,this,args)
        const active=Object.values(manager.pthreads).map(worker=>records.get(worker))
        if(!active.length||active.some(record=>!record?.active||record.closed||
          Atomics.load(record.active.state,0)>=FAILED))return Reflect.apply(getNew,this,args)
        const remaining=deadline-now()
        if(remaining<=0)return Reflect.apply(getNew,this,args)
        // This waits for a real completion notification, not a timer or a
        // parent message callback. Capacity exhaustion remains bounded.
        Atomics.wait(changed,0,version,remaining)
      }
    }
    return manager
  }
  return {connect,install,inspect:()=>({disposed,workers:workers.size,allocations,reclaims}),
    dispose(){if(disposed)return;disposed=true;for(const worker of workers)worker.terminate();notify()},
  }
}

// Use the same pinned NAPI implementation as the caller. These are its public
// create/load functions, passed in rather than resolved from a second package.
export async function instantiateNativeWasiModule(createNapiModule,loadNapiModule,input,options){
  const pool=createNativeWasiThreadPool()
  const configured={...options,onCreateWorker(...args){return pool.connect(options.onCreateWorker(...args))}}
  try{
    const napiModule=createNapiModule(configured)
    pool.install(napiModule.PThread)
    const result=await loadNapiModule(napiModule,input,configured)
    return {...result,napiModule,nativeThreadPool:pool}
  }catch(error){pool.dispose();throw error}
}

export function createNativeWasiMessageHandler(MessageHandler,options){
  let active
  const send=options.postMessage??globalThis.postMessage.bind(globalThis)
  const settle=status=>{
    if(active&&Atomics.compareExchange(active.state,0,RUNNING,status)===RUNNING){
      Atomics.add(active.changed,0,1);Atomics.notify(active.changed,0)
    }
  }
  const handler=new MessageHandler({...options,postMessage(message,...args){
    const thread=message?.__emnapi__
    if(thread?.type==='cleanup-thread'&&thread.payload?.tid===active?.tid)settle(COMPLETE)
    else if(thread?.type==='terminate-all-threads')settle(FAILED)
    return send(message,...args)
  }})
  return {handle(event){
    const thread=event?.data?.__emnapi__
    if(thread?.type==='start'){
      const completion=thread.payload?.[field]
      if(!completion||completion.tid!==thread.payload.tid||!isSharedLane(completion.state)||!isSharedLane(completion.changed))
        throw TypeError('Invalid native thread completion handoff')
      if(active&&Atomics.load(active.state,0)===RUNNING)throw Error('Native thread worker is still running')
      active=completion
    }
    try{return handler.handle(event)}catch(error){settle(FAILED);throw error}
  }}
}
