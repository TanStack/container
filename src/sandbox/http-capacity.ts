const pools=new WeakMap<object,{active:number;waiting:Array<()=>void>}>()

/** Queue HTTP connections, retaining capacity until their response is consumed. */
export async function acquireHTTPCapacity(owner:object,signal:AbortSignal){
  let pool=pools.get(owner)
  if(!pool){pool={active:0,waiting:[]};pools.set(owner,pool)}
  const state=pool
  signal.throwIfAborted()
  if(state.active>=32){
    await new Promise<void>((resolve,reject)=>{
      const ready=()=>{signal.removeEventListener('abort',abort);resolve()}
      const abort=()=>{
        const index=state.waiting.indexOf(ready)
        if(index>=0)state.waiting.splice(index,1)
        reject(signal.reason)
      }
      state.waiting.push(ready)
      signal.addEventListener('abort',abort,{once:true})
    })
  }else state.active++
  let released=false
  return ()=>{
    if(released)return
    released=true
    const next=state.waiting.shift()
    if(next)next()
    else state.active--
  }
}
