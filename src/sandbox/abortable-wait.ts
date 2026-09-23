// Detach one consumer without cancelling a shared asset operation.
export async function abortableWait<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){
    // The caller already started this promise. Observe a later rejection even
    // though this consumer will never await its result.
    void pending.catch(()=>{})
    throw signal.reason
  }
  let abort!:()=>void
  const cancelled=new Promise<never>((_,reject)=>{
    abort=()=>reject(signal.reason)
    signal.addEventListener('abort',abort,{once:true})
  })
  try{return await Promise.race([pending,cancelled])}
  finally{signal.removeEventListener('abort',abort)}
}
