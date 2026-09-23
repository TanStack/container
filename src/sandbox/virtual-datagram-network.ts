export type DatagramFamily='udp4'|'udp6'
export type DatagramEvent={type:'message';bytes:Uint8Array;rinfo:{address:string;family:'IPv4'|'IPv6';port:number;size:number}}|{type:'close'}
type Endpoint={id:number;owner:number;family:DatagramFamily;address:string;port:number;bound:boolean;ref:boolean;reuseAddr:boolean;broadcast:boolean;connected?:{address:string;port:number};events:DatagramEvent[];bytes:number;pending?:(event:DatagramEvent|null)=>void;memberships:Set<string>}
const failure=(code:string,message=code)=>Object.assign(Error(message),{code})

/** Per-kernel packet transport. It never creates an operating-system socket. */
export class VirtualDatagramNetwork {
  #handles=new Map<number,Endpoint>();#ports=new Map<string,Set<number>>();#next=1;#ephemeral=49152
  readonly maxPacketBytes=65507;readonly maxQueuedBytes=1024*1024
  get size(){return this.#handles.size}get bound(){return [...this.#handles.values()].filter(value=>value.bound).length}
  #get(owner:number,id:number){const value=this.#handles.get(id);if(!value||value.owner!==owner)throw failure('EBADF','Datagram handle is unavailable to this owner');return value}
  #key(family:DatagramFamily,port:number){return family+':'+port}
  #port(port:number){if(!Number.isInteger(port)||port<0||port>65535)throw failure('ERR_SOCKET_BAD_PORT');return port}
  #address(family:DatagramFamily,address:string,send=false){
    const local=family==='udp4'?['127.0.0.1','0.0.0.0','localhost']:['::1','::','localhost']
    const multicast=family==='udp4'?/^2(?:2[4-9]|3\d)\./.test(address):/^ff/i.test(address)
    if(!local.includes(address)&&!(send&&multicast))throw failure('EACCES','Only sandbox-local datagram addresses are supported')
    return address==='localhost'?(family==='udp4'?'127.0.0.1':'::1'):address
  }
  #allocate(family:DatagramFamily){for(let i=0;i<16384;i++){const port=this.#ephemeral++;if(this.#ephemeral>65535)this.#ephemeral=49152;if(!this.#ports.has(this.#key(family,port)))return port}throw failure('EADDRINUSE')}
  create(owner:number,family:DatagramFamily,reuseAddr=false){if(family!=='udp4'&&family!=='udp6')throw failure('ERR_INVALID_ARG_VALUE');if(this.#handles.size>=256)throw failure('EMFILE','Virtual datagram socket limit exceeded');const value:Endpoint={id:this.#next++,owner,family,address:family==='udp4'?'0.0.0.0':'::',port:0,bound:false,ref:true,reuseAddr:!!reuseAddr,broadcast:false,events:[],bytes:0,memberships:new Set()};this.#handles.set(value.id,value);return {id:value.id}}
  bind(owner:number,id:number,port=0,address?:string){const value=this.#get(owner,id);if(value.bound)throw failure('ERR_SOCKET_ALREADY_BOUND');this.#port(port);address=this.#address(value.family,address??(value.family==='udp4'?'0.0.0.0':'::'));if(port===0)port=this.#allocate(value.family);const key=this.#key(value.family,port),existing=this.#ports.get(key);if(existing&&(!value.reuseAddr||[...existing].some(key=>!this.#handles.get(key)?.reuseAddr)))throw failure('EADDRINUSE');value.address=address;value.port=port;value.bound=true;if(existing)existing.add(id);else this.#ports.set(key,new Set([id]));return this.address(owner,id)}
  address(owner:number,id:number){const value=this.#get(owner,id);if(!value.bound)throw failure('EBADF','getsockname EBADF');return {address:value.address,family:value.family==='udp4'?'IPv4':'IPv6',port:value.port}}
  connect(owner:number,id:number,port:number,address:string){const value=this.#get(owner,id);this.#port(port);address=this.#address(value.family,address,true);if(!value.bound)this.bind(owner,id);if(value.connected)throw failure('ERR_SOCKET_DGRAM_IS_CONNECTED');value.connected={port,address};return this.remoteAddress(owner,id)}
  disconnect(owner:number,id:number){const value=this.#get(owner,id);if(!value.connected)throw failure('ERR_SOCKET_DGRAM_NOT_CONNECTED');value.connected=undefined}
  remoteAddress(owner:number,id:number){const value=this.#get(owner,id),remote=value.connected;if(!remote)throw failure('ERR_SOCKET_DGRAM_NOT_CONNECTED');return {address:remote.address,family:value.family==='udp4'?'IPv4':'IPv6',port:remote.port}}
  send(owner:number,id:number,bytes:Uint8Array,port?:number,address?:string){
    const source=this.#get(owner,id);if(!(bytes instanceof Uint8Array)||bytes.length>this.maxPacketBytes)throw failure('EMSGSIZE');if(!source.bound)this.bind(owner,id)
    if(source.connected){if(port!==undefined||address!==undefined)throw failure('ERR_SOCKET_DGRAM_IS_CONNECTED');({port,address}=source.connected)}else {if(port===undefined)throw failure('ERR_SOCKET_BAD_PORT');this.#port(port);address=this.#address(source.family,address??(source.family==='udp4'?'127.0.0.1':'::1'),true)}
    const multicast=source.family==='udp4'?/^2(?:2[4-9]|3\d)\./.test(address!):/^ff/i.test(address!)
    let ids=[...(this.#ports.get(this.#key(source.family,port!))??[])].filter(key=>{const target=this.#handles.get(key);return target&&(multicast?target.memberships.has(address!):true)})
    if(!multicast)ids=ids.slice(0,1)
    for(const key of ids){const target=this.#handles.get(key)!;if(target.events.length>=256||target.bytes+bytes.length>this.maxQueuedBytes)throw failure('ENOBUFS','Datagram receive queue is full')}
    for(const key of ids){const target=this.#handles.get(key)!;const copy=bytes.slice(),event:DatagramEvent={type:'message',bytes:copy,rinfo:{address:source.address==='0.0.0.0'?'127.0.0.1':source.address==='::'?'::1':source.address,family:source.family==='udp4'?'IPv4':'IPv6',port:source.port,size:copy.length}};if(target.pending){const done=target.pending;target.pending=undefined;done(event)}else {target.events.push(event);target.bytes+=copy.length}}
    return bytes.length
  }
  next(owner:number,id:number){const value=this.#get(owner,id);if(value.pending)throw failure('EBUSY');const event=value.events.shift();if(event){if(event.type==='message')value.bytes-=event.bytes.length;return Promise.resolve(event)}return new Promise<DatagramEvent|null>(resolve=>value.pending=resolve)}
  close(owner:number,id:number){const value=this.#get(owner,id);if(value.bound){const key=this.#key(value.family,value.port),set=this.#ports.get(key);set?.delete(id);if(!set?.size)this.#ports.delete(key)}this.#handles.delete(id);value.pending?.(null);return undefined}
  membership(owner:number,id:number,address:string,add:boolean,iface?:string){const value=this.#get(owner,id);if(iface!==undefined&&iface!==''&&iface!=='virtual')throw failure('ERR_UNSUPPORTED_OPERATION','Real network interfaces are unavailable');address=this.#address(value.family,address,true);const multicast=value.family==='udp4'?/^2(?:2[4-9]|3\d)\./.test(address):/^ff/i.test(address);if(!multicast)throw failure('EINVAL','Membership requires a multicast address');if(!value.bound)this.bind(owner,id);if(add)value.memberships.add(address);else value.memberships.delete(address)}
  broadcast(owner:number,id:number,enabled:boolean){this.#get(owner,id).broadcast=!!enabled}
  ref(owner:number,id:number,enabled:boolean){this.#get(owner,id).ref=!!enabled}
  hasReferences(owner:number){return [...this.#handles.values()].some(value=>value.owner===owner&&value.ref)}
  release(owner:number){for(const value of [...this.#handles.values()])if(value.owner===owner)this.close(owner,value.id)}
}

export function datagramCall(network:VirtualDatagramNetwork,owner:number,method:string,args:any[]):unknown{
  switch(method){case'create':return network.create(owner,args[0],args[1]);case'bind':return network.bind(owner,args[0],args[1],args[2]??undefined);case'address':return network.address(owner,args[0]);case'connect':return network.connect(owner,args[0],args[1],args[2]);case'disconnect':return network.disconnect(owner,args[0]);case'remoteAddress':return network.remoteAddress(owner,args[0]);case'send':return network.send(owner,args[0],Uint8Array.from(args[1]),args[2]??undefined,args[3]??undefined);case'close':return network.close(owner,args[0]);case'membership':return network.membership(owner,args[0],args[1],args[2],args[3]??undefined);case'broadcast':return network.broadcast(owner,args[0],args[1]);case'ref':return network.ref(owner,args[0],args[1]);default:throw failure('EINVAL','Unknown virtual datagram operation')}
}
