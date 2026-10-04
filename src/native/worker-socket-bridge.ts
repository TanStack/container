import {socketBytesForTransfer} from './socket-transfer'

type Socket={read:()=>Promise<any>;write:(bytes:Uint8Array)=>Promise<void>;end:()=>Promise<void>;close:()=>Promise<void>}

export function bridgeWorkerSocket(socket:Socket,channel:MessagePort,onClose?:()=>void){
  let stopped=false
  let acknowledge:(()=>void)|undefined
  let incoming=Promise.resolve()
  const close=async(notifyPeer=true)=>{
    if(stopped)return
    stopped=true
    acknowledge?.()
    if(notifyPeer)try{channel.postMessage({type:'close'})}catch{}
    channel.close()
    try{await socket.close()}finally{onClose?.()}
  }
  channel.onmessage=({data})=>{
    if(data.type==='ack'){acknowledge?.();acknowledge=undefined;return}
    incoming=incoming.then(async()=>{
      if(stopped)return
      if(data.type==='data'){
        await socket.write(data.bytes)
        channel.postMessage({type:'ack'})
      }else if(data.type==='end')await socket.end()
      else if(data.type==='close'||data.type==='error')await close(false)
    }).catch(()=>close())
  }
  void(async()=>{
    try{
      while(!stopped){
        const event=await socket.read()
        if(!event||event.type==='close')break
        if(event.type==='data'){
          const bytes=socketBytesForTransfer(event.bytes)
          channel.postMessage({type:'data',bytes},[bytes.buffer])
          await new Promise<void>(resolve=>{acknowledge=resolve})
        }else if(event.type==='end')channel.postMessage({type:'end'})
        else if(event.type==='error')throw Error(event.code)
      }
    }catch{if(!stopped)channel.postMessage({type:'error'})}
    await close()
  })()
  return close
}
