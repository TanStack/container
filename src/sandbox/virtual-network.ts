export type NetworkEvent={type:'connection';id:number;port:number;remotePort:number}|{type:'data';bytes:Uint8Array}|{type:'end'}|{type:'close'}|{type:'error';code:string}
export type PortEvent={type:'open'|'close';port:number}
type PendingWrite={bytes:Uint8Array;resolve:()=>void;reject:(error:Error)=>void}
type Handle={id:number;owner:number;ref:boolean;events:NetworkEvent[];pending?:(event:NetworkEvent|null)=>void}
type Listener=Handle&{kind:'server';port:number;listening:boolean;connections:Set<number>;shareKey?:string}
type Socket=Handle&{kind:'socket';port:number;remotePort:number;peer:number;server:number;ended:boolean;buffered:number;write?:PendingWrite}
type ListenerGroup={listeners:Listener[];shareKey?:string;cursor:number}
const failure=(code:string,message=code)=>Object.assign(Error(message),{code})

/** A per-kernel byte transport. It never opens an operating-system socket. */
export class VirtualNetwork {
  #handles=new Map<number,Listener|Socket>()
  #ports=new Map<number,ListenerGroup>()
  #portListeners=new Set<(event:PortEvent)=>void>()
  #next=1
  #ephemeral=49152
  readonly maxBufferedBytes=64*1024
  get size(){return this.#handles.size}
  get listening(){return this.#ports.size}
  get listeningPorts(){return [...this.#ports.keys()].sort((a,b)=>a-b)}
  snapshot(){
    return [...this.#handles.values()].slice(0,256).map(handle=>handle.kind==='server'?{
      id:handle.id,owner:handle.owner,kind:handle.kind,port:handle.port,ref:handle.ref,
      pending:Boolean(handle.pending),events:handle.events.map(event=>event.type),
      listening:handle.listening,connections:handle.connections.size,
    }:{
      id:handle.id,owner:handle.owner,kind:handle.kind,port:handle.port,remotePort:handle.remotePort,
      server:handle.server,peer:handle.peer,ref:handle.ref,pending:Boolean(handle.pending),
      events:handle.events.map(event=>event.type),ended:handle.ended,buffered:handle.buffered,
      writePending:Boolean(handle.write),
    })
  }
  subscribePorts(listener:(event:PortEvent)=>void){
    const subscription=(event:PortEvent)=>listener(event)
    this.#portListeners.add(subscription)
    for(const port of this.listeningPorts)if(this.#portListeners.has(subscription)&&this.#ports.has(port))this.#notifyPort(subscription,{type:'open',port})
    return ()=>{this.#portListeners.delete(subscription)}
  }
  #notifyPort(listener:(event:PortEvent)=>void,event:PortEvent){
    try{listener(Object.freeze({...event}))}catch{/* Observers must not affect network operations. */}
  }
  #emitPort(type:PortEvent['type'],port:number){
    for(const listener of [...this.#portListeners])if(this.#portListeners.has(listener)&&this.#ports.has(port)===(type==='open'))this.#notifyPort(listener,{type,port})
  }
  #get(owner:number,id:number){
    const handle=this.#handles.get(id)
    if(!handle||handle.owner!==owner)throw failure('EBADF','Socket handle is unavailable to this owner')
    return handle
  }
  #socket(owner:number,id:number){const handle=this.#get(owner,id);if(handle.kind!=='socket')throw failure('EINVAL');return handle}
  #allocatePort(){
    for(let i=0;i<16384;i++){const port=this.#ephemeral++;if(this.#ephemeral>65535)this.#ephemeral=49152;if(!this.#ports.has(port))return port}
    throw failure('EADDRINUSE')
  }
  #validatePort(port:number){if(!Number.isInteger(port)||port<0||port>65535)throw failure('ERR_SOCKET_BAD_PORT')}
  #host(host:string){if(!['localhost','127.0.0.1','::1','0.0.0.0','::'].includes(host))throw failure('EACCES','Only sandbox-local addresses are supported')}
  #emit(handle:Handle,event:NetworkEvent){
    if(handle.pending){const resolve=handle.pending;handle.pending=undefined;resolve(event)}else handle.events.push(event)
  }
  listen(owner:number,port=0,host='127.0.0.1',shareKey?:string){
    this.#validatePort(port);this.#host(host)
    if(port===0)port=this.#allocatePort()
    const group=this.#ports.get(port)
    if((!group&&this.#ports.size>=32)||this.#handles.size>=256)throw failure('EMFILE','Virtual socket limit exceeded')
    if(group&&(!shareKey||group.shareKey!==shareKey||group.listeners.some(listener=>listener.owner===owner)))throw failure('EADDRINUSE')
    const listener:Listener={id:this.#next++,owner,kind:'server',port,listening:true,connections:new Set(),ref:true,events:[],shareKey}
    if(group)group.listeners.push(listener);else this.#ports.set(port,{listeners:[listener],shareKey,cursor:0});this.#handles.set(listener.id,listener)
    if(!group)this.#emitPort('open',port)
    return {id:listener.id,port}
  }
  connect(owner:number,port:number,host='127.0.0.1'){
    this.#validatePort(port);this.#host(host)
    const group=this.#ports.get(port)
    if(!group?.listeners.length)throw failure('ECONNREFUSED')
    const server=group.listeners[group.cursor%group.listeners.length]!
    group.cursor=(group.cursor+1)%group.listeners.length
    if(this.#handles.size+2>256)throw failure('EMFILE','Virtual socket limit exceeded')
    const clientId=this.#next++,acceptedId=this.#next++,localPort=this.#allocatePort()
    const make=(id:number,owner:number,port:number,remotePort:number,peer:number):Socket=>({id,owner,kind:'socket',port,remotePort,peer,server:server.id,ended:false,buffered:0,ref:true,events:[]})
    this.#handles.set(clientId,make(clientId,owner,localPort,port,acceptedId))
    this.#handles.set(acceptedId,make(acceptedId,server.owner,port,localPort,clientId))
    server.connections.add(acceptedId)
    this.#emit(server,{type:'connection',id:acceptedId,port,remotePort:localPort})
    return {id:clientId,port:localPort,remotePort:port}
  }
  async next(owner:number,id:number):Promise<NetworkEvent|null>{
    const handle=this.#get(owner,id)
    if(handle.pending)throw failure('EBUSY','A socket read is already pending')
    const event=handle.events.shift()
    if(event){
      if(event.type==='data'&&handle.kind==='socket'){
        handle.buffered-=event.bytes.length
        const sender=this.#handles.get(handle.peer)
        if(sender?.kind==='socket')this.#flushWrite(sender)
      }
      if(event.type==='close')this.#handles.delete(id)
      return event
    }
    return new Promise(resolve=>handle.pending=resolve)
  }
  #flushWrite(socket:Socket){
    const pending=socket.write
    if(!pending)return
    const peer=this.#handles.get(socket.peer)
    if(peer?.kind!=='socket'){socket.write=undefined;pending.reject(failure('EPIPE'));return}
    if(!peer.pending&&(peer.buffered+pending.bytes.length>this.maxBufferedBytes||peer.events.length>=256))return
    socket.write=undefined
    if(!peer.pending)peer.buffered+=pending.bytes.length
    this.#emit(peer,{type:'data',bytes:pending.bytes});pending.resolve()
  }
  write(owner:number,id:number,bytes:Uint8Array):Promise<void>{
    const socket=this.#socket(owner,id)
    if(!(bytes instanceof Uint8Array)||bytes.length>this.maxBufferedBytes)throw failure('ERR_RESOURCE_LIMIT','Socket writes are limited to 64 KiB')
    if(socket.ended)throw failure('EPIPE')
    if(socket.write)throw failure('EBUSY','A socket write is already pending')
    if(!bytes.length)return Promise.resolve()
    return new Promise((resolve,reject)=>{socket.write={bytes:bytes.slice(),resolve,reject};this.#flushWrite(socket)})
  }
  end(owner:number,id:number){
    const socket=this.#socket(owner,id)
    if(socket.ended)return
    if(socket.write)throw failure('EBUSY','Wait for pending writes before ending the socket')
    socket.ended=true
    const peer=this.#handles.get(socket.peer)
    if(peer?.kind==='socket')this.#emit(peer,{type:'end'})
  }
  destroy(owner:number,id:number){
    const socket=this.#socket(owner,id)
    this.#handles.delete(id);socket.pending?.(null);socket.write?.reject(failure('ECANCELED'))
    const peer=this.#handles.get(socket.peer)
    if(peer?.kind==='socket'){
      if(!socket.ended)this.#emit(peer,{type:'error',code:'ECONNRESET'})
      this.#flushWrite(peer)
    }
    const server=this.#handles.get(socket.server)
    if(server?.kind==='server'){server.connections.delete(id);this.#finishServer(server)}
  }
  closeServer(owner:number,id:number){
    const server=this.#get(owner,id)
    if(server.kind!=='server')throw failure('EINVAL')
    if(server.listening){server.listening=false;this.#removeListener(server)}
    this.#finishServer(server)
  }
  #finishServer(server:Listener){
    if(!server.listening&&!server.connections.size){
      server.ref=false
      if(server.pending){this.#emit(server,{type:'close'});this.#handles.delete(server.id)}
      else if(!server.events.some(event=>event.type==='close'))this.#emit(server,{type:'close'})
    }
  }
  #removeListener(server:Listener){
    const group=this.#ports.get(server.port);if(!group)return
    const index=group.listeners.indexOf(server);if(index<0)return
    group.listeners.splice(index,1);if(index<group.cursor)group.cursor--;if(group.listeners.length)group.cursor%=group.listeners.length;else {this.#ports.delete(server.port);this.#emitPort('close',server.port)}
  }
  connections(owner:number,id:number){const server=this.#get(owner,id);if(server.kind!=='server')throw failure('EINVAL');return server.connections.size}
  ref(owner:number,id:number,ref:boolean){this.#get(owner,id).ref=!!ref}
  hasReferences(owner:number){return [...this.#handles.values()].some(handle=>handle.owner===owner&&handle.ref)}
  release(owner:number){
    for(const handle of [...this.#handles.values()])if(handle.owner===owner){
      if(handle.kind==='socket'){if(this.#handles.has(handle.id))this.destroy(owner,handle.id)}
      else {this.#removeListener(handle);handle.pending?.(null);this.#handles.delete(handle.id)}
    }
  }
}

export function networkCall(network:VirtualNetwork,owner:number,method:string,args:any[]):unknown{
  switch(method){
    case 'listen':return network.listen(owner,args[0],args[1],args[2])
    case 'connect':return network.connect(owner,args[0],args[1])
    case 'end':return network.end(owner,args[0])
    case 'destroy':return network.destroy(owner,args[0])
    case 'closeServer':return network.closeServer(owner,args[0])
    case 'connections':return network.connections(owner,args[0])
    case 'ref':return network.ref(owner,args[0],args[1])
    default:throw failure('EINVAL','Unknown virtual network operation')
  }
}
