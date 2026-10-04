export async function probeSocketShutdown(net,trace=()=>{}){
  const rows=[]
  for(const [reset,buffered] of [[false,false],[true,false],[false,true]]){
    const peerEvents=[],localErrors=[]
    let payload=''
    let peer,client,accept,closePeer
    const accepted=new Promise(resolve=>{accept=resolve})
    const closed=new Promise(resolve=>{closePeer=resolve})
    const server=net.createServer(socket=>{
      peer=socket
      socket.on('data',chunk=>{payload+=chunk.toString()})
      socket.on('error',error=>peerEvents.push('error:'+error.code))
      socket.on('end',()=>peerEvents.push('end'))
      socket.on('close',hadError=>{peerEvents.push('close:'+hadError);closePeer()})
      if(buffered)socket.pause();else socket.resume()
      accept()
    })
    let timer
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
      client=net.connect(server.address().port,'127.0.0.1')
      client.on('error',error=>localErrors.push(error.code))
      await new Promise(resolve=>client.once('connect',resolve))
      await accepted
      if(buffered)await new Promise((resolve,reject)=>client.write('payload',error=>error?reject(error):resolve()))
      if(reset)client.resetAndDestroy();else client.destroy()
      if(buffered)peer.resume()
      await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Peer shutdown timed out')),5000)})])
      rows.push({reset,buffered,payload,peerEvents,localErrors})
    }finally{
      clearTimeout(timer);client?.destroy();peer?.destroy()
      await new Promise(resolve=>server.close(resolve))
    }
  }
  for(const preDestroyed of [false,true]){
    trace('reset-state:start:'+preDestroyed)
    const socket=new net.Socket(),errors=[]
    socket.on('error',error=>{trace('reset-state:error:'+error.code);errors.push(error.code)})
    const closed=new Promise(resolve=>socket.once('close',()=>{trace('reset-state:close:'+preDestroyed);resolve()}))
    if(preDestroyed)socket.destroy()
    const same=socket.resetAndDestroy()===socket
    await closed
    trace('reset-state:finished:'+preDestroyed)
    rows.push({preDestroyed,same,errors})
  }
  for(const refused of [false,true]){
    const peers=new Set(),events=[],errors=[]
    const server=net.createServer(socket=>{
      peers.add(socket)
      socket.on('error',()=>{})
      socket.on('close',()=>peers.delete(socket))
      socket.resume()
    })
    let client
    let listening=false
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
      listening=true
      const port=server.address().port
      if(refused){await new Promise(resolve=>server.close(resolve));listening=false}
      client=net.connect(port,'127.0.0.1')
      client.on('connect',()=>events.push('connect'))
      client.on('error',error=>errors.push(error.code))
      const closed=new Promise(resolve=>client.once('close',hadError=>{events.push('close:'+hadError);resolve()}))
      const connectingAtReset=client.connecting
      const same=client.resetAndDestroy()===client
      const destroyedAtReset=client.destroyed
      await closed
      rows.push({connectingReset:true,refused,connectingAtReset,same,destroyedAtReset,events,errors})
    }finally{
      client?.destroy()
      for(const peer of peers)peer.destroy()
      if(listening)await new Promise(resolve=>server.close(resolve))
    }
  }
  return rows
}

export const socketShutdownSource=`import net from 'node:net';
const probe=${probeSocketShutdown.toString()};console.log(JSON.stringify(await probe(net${process.env.NATIVE_SOCKET_TRACE==='1'?',message=>console.log("SOCKET_TRACE "+message)':''})));`
