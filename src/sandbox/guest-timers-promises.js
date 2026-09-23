const invalid=message=>Object.assign(new TypeError(message),{code:'ERR_INVALID_ARG_TYPE'})
const aborted=signal=>Object.assign(new Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR',cause:signal.reason})
function settings(options){
  if(options===undefined)return {ref:true}
  if(options===null||typeof options!=='object'||Array.isArray(options))throw invalid('options must be an object')
  const {signal,ref=true}=options
  if(typeof ref!=='boolean')throw invalid('ref must be a boolean')
  if(signal!==undefined&&(signal===null||typeof signal!=='object'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'||typeof signal.aborted!=='boolean'))throw invalid('signal must be an AbortSignal')
  return {signal,ref}
}
function schedule(kind,delay,value,options){
  return new Promise((resolve,reject)=>{
    const {signal,ref}=settings(options)
    if(signal?.aborted){reject(aborted(signal));return}
    let handle
    const clear=()=>kind==='immediate'?globalThis.clearImmediate(handle):globalThis.clearTimeout(handle)
    const cleanup=()=>signal?.removeEventListener('abort',onAbort)
    const onAbort=()=>{clear();cleanup();reject(aborted(signal))}
    const done=()=>{cleanup();resolve(value)}
    handle=kind==='immediate'?globalThis.setImmediate(done):globalThis.setTimeout(done,delay)
    if(!ref)handle.unref?.()
    signal?.addEventListener('abort',onAbort,{once:true})
  })
}
export function setTimeout(delay=1,value,options){return schedule('timeout',delay,value,options)}
export function setImmediate(value,options){return schedule('immediate',0,value,options)}
export async function* setInterval(delay=1,value,options){
  const {signal,ref}=settings(options)
  if(signal?.aborted)throw aborted(signal)
  let pending=0,wake
  const onAbort=()=>{wake?.();wake=undefined}
  const handle=globalThis.setInterval(()=>{pending++;wake?.();wake=undefined},delay)
  if(!ref)handle.unref?.()
  signal?.addEventListener('abort',onAbort,{once:true})
  try{
    while(!signal?.aborted){
      if(!pending)await new Promise(resolve=>{wake=resolve})
      if(signal?.aborted)break
      pending--;yield value
    }
    throw aborted(signal)
  }finally{globalThis.clearInterval(handle);signal?.removeEventListener('abort',onAbort)}
}
export const scheduler={wait:(delay,options)=>setTimeout(delay,undefined,options),yield:()=>setImmediate()}
export default {setTimeout,setImmediate,setInterval,scheduler}
