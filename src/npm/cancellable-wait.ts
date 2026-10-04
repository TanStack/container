/** Cancel one caller's wait without cancelling work shared with other callers. */
export function cancellableWait<T>(operation:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return operation
  if(signal.aborted)return Promise.reject(signal.reason)
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason)}
    const cleanup=()=>signal.removeEventListener('abort',abort)
    signal.addEventListener('abort',abort,{once:true})
    operation.then(value=>{cleanup();resolve(value)},error=>{cleanup();reject(error)})
  })
}
