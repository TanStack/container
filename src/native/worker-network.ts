import {connectVirtual,network} from '../vite-browser/runtime-network'
import {bridgeWorkerSocket} from './worker-socket-bridge'

type Socket={read:()=>Promise<any>;write:(bytes:Uint8Array)=>Promise<void>;end:()=>Promise<void>;close:()=>Promise<void>}

export function forwardWorkerPort(worker:Worker,port:number,reserved=false){
  const owner=3
  const listener=reserved?network.listenReserved(owner,port):network.listen(owner,port)
  const connections=new Set<()=>Promise<void>>()
  let closed=false
  void(async()=>{
    while(!closed){
      const event=await network.next(owner,listener.id)
      if(!event||event.type==='close')break
      if(event.type!=='connection')continue
      const id=event.id
      const channel=new MessageChannel()
      const socket:Socket={
        read:()=>network.next(owner,id),
        write:bytes=>network.write(owner,id,bytes),
        end:async()=>{network.end(owner,id)},
        close:async()=>{try{network.destroy(owner,id)}catch{}},
      }
      let stop:()=>Promise<void>
      stop=bridgeWorkerSocket(socket,channel.port1,()=>connections.delete(stop))
      connections.add(stop)
      worker.postMessage({type:'native-thread-connect',port,channel:channel.port2},[channel.port2])
    }
  })()
  return ()=>{
    if(closed)return
    closed=true
    network.closeServer(owner,listener.id)
    for(const stop of connections)void stop()
    connections.clear()
  }
}

export async function connectWorkerPort(port:number,channel:MessagePort){
  try{bridgeWorkerSocket(await connectVirtual(port),channel)}
  catch{channel.postMessage({type:'error'});channel.close()}
}
