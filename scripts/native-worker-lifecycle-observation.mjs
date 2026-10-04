// Test-only observer. Holds metadata, not workers, and leaves calls unchanged.
export function installNativeWorkerLifecycleObservation(){
  if(location.pathname!=='/owner.html')return
  const OriginalWorker=globalThis.Worker,descriptor=Object.getOwnPropertyDescriptor(globalThis,'Worker')
  if(typeof OriginalWorker!=='function'||!descriptor?.configurable)return
  const identities=new WeakMap(),active=new Map()
  let next=0
  const record=row=>{try{console.info('NATIVE_WORKER_LIFECYCLE '+JSON.stringify({
    ...row,realm:location.href,elapsedMs:Math.round(performance.now()),live:active.size,
  }))}catch{}}
  const originalTerminate=OriginalWorker.prototype.terminate
  OriginalWorker.prototype.terminate=function(){
    const result=Reflect.apply(originalTerminate,this,arguments)
    const id=identities.get(this)
    if(id!==undefined&&active.has(id)){
      active.delete(id)
      record({kind:'termination-requested',id})
    }
    return result
  }
  const ObservedWorker=new Proxy(OriginalWorker,{construct(target,args,newTarget){
    const worker=Reflect.construct(target,args,newTarget)
    const id=++next
    identities.set(worker,id)
    active.set(id,true)
    let path
    try{path=new URL(String(args[0]),location.href).pathname}catch{}
    record({kind:'constructed',id,path})
    return worker
  }})
  Object.defineProperty(globalThis,'Worker',{...descriptor,value:ObservedWorker})
}
