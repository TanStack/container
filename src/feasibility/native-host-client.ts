// Experiment-owned client. Closing rejects pending calls and terminates its worker.
export function createNativeHost(){
  const worker=new Worker('/native-host.js',{type:'module'})
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  let next=0,closed=false
  const close=(error=new Error('Native host closed'))=>{
    if(closed)return
    closed=true;worker.terminate()
    for(const call of pending.values()){clearTimeout(call.timer);call.reject(error)}
    pending.clear()
  }
  worker.onmessage=({data})=>{
    const call=pending.get(data.id)
    if(!call)return
    pending.delete(data.id);clearTimeout(call.timer);call.resolve(data)
  }
  worker.onerror=event=>close(new Error(event.message))
  return {close,call:(message:Record<string,unknown>):Promise<any>=>{
    if(closed)return Promise.reject(new Error('Native host closed'))
    return new Promise((resolve,reject)=>{
      const id=++next,timer=setTimeout(()=>close(new Error('Native host timeout')),30000)
      pending.set(id,{resolve,reject,timer});worker.postMessage({id,...message})
    })
  }}
}
