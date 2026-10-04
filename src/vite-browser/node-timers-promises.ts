export function setTimeout<T=void>(delay=0,value?:T,options?:{signal?:AbortSignal}):Promise<T>{
  return new Promise((resolve,reject)=>{
    if(options?.signal?.aborted){reject(options.signal.reason);return}
    const timer=globalThis.setTimeout(()=>{
      options?.signal?.removeEventListener('abort',abort)
      resolve(value as T)
    },delay)
    const abort=()=>{
      globalThis.clearTimeout(timer)
      reject(options!.signal!.reason)
    }
    options?.signal?.addEventListener('abort',abort,{once:true})
  })
}

export function setImmediate<T=void>(value?:T,options?:{signal?:AbortSignal}):Promise<T>{
  return setTimeout(0,value,options)
}

export default {setTimeout,setImmediate}
