import {abortableWait} from './abortable-wait'

export async function withStartupDeadline<T>(parent:AbortSignal,timeoutMs:number,operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  parent.throwIfAborted()
  const controller=new AbortController(),deadline=performance.now()+timeoutMs
  const timeout=()=>Object.assign(Error('Engine startup timed out'),{code:'ERR_ENGINE_STARTUP_TIMEOUT'})
  const abort=()=>controller.abort(parent.reason)
  parent.addEventListener('abort',abort,{once:true})
  const timer=setTimeout(()=>controller.abort(timeout()),timeoutMs)
  try{
    const result=await abortableWait(Promise.resolve().then(()=>{
      controller.signal.throwIfAborted()
      return operation(controller.signal)
    }),controller.signal)
    controller.signal.throwIfAborted()
    // A synchronous loader can delay timer delivery. Do not accept a late result.
    if(performance.now()>deadline)throw timeout()
    return result
  }finally{
    controller.abort(Error('Engine startup scope ended'))
    clearTimeout(timer);parent.removeEventListener('abort',abort)
  }
}
