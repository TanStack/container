function createRoutedPorts(host,EventEmitter,encode,decode){
 const states=new WeakMap(),adopted=new Map(),eventListeners=new WeakMap(),token={}
 const failure=()=>Object.assign(Error('MessagePort is closed or transferred'),{code:'ERR_INVALID_STATE'})
 const state=port=>{const value=states.get(port);if(!value||value.closed)throw failure();return value}
 // Keep host ownership until decoding adopts the payload. On decoding failure,
 // the same acknowledgement drops the delivery rather than replaying it.
 const consume=(own,delivery)=>{try{return decode(delivery.bytes,{scope:'port',endpoint:own.key,token:delivery.token})}finally{host.proc.call('routedPortAck',own.key,delivery.token)}}
 class MessagePort extends EventEmitter {
  constructor(key,secret){super();if(secret!==token)throw new TypeError('Illegal constructor');states.set(this,{key,closed:false,started:false,pending:[],ref:false});adopted.set(key,this)}
  postMessage(value,transfer=[]){const own=state(this),prepared=encode(value,transfer);try{host.proc.call('routedPortSend',own.key,prepared.bytes,prepared.ports,prepared.shared,prepared.modules);prepared.commit()}catch(error){prepared.rollback?.();throw error}}
  start(){const own=state(this);if(own.started)return;own.started=true;void this._pump().catch(error=>{if(!own.closed){this.close();this.emit('messageerror',error)}})}
  async _pump(){const own=state(this);while(!own.closed){const delivery=await host.proc.portNext(own.key);if(own.closed)return;if(delivery===null){this.close();return}const value=consume(own,delivery);if(this.listenerCount('message'))globalThis[Symbol.for('web-container:task-queue')].task(this.emit,this,['message',value]);else{if(own.pending.length>=256)throw Error('MessagePort guest queue exceeded');own.pending.push(value)}}}
  on(name,listener){super.on(name,listener);if(name==='message'){this.start();this.ref();const own=state(this);while(own.pending.length&&this.listenerCount('message'))this.emit('message',own.pending.shift())}return this}
  addListener(name,listener){return this.on(name,listener)}
  once(name,listener){const wrapper=(...args)=>{this.off(name,wrapper);listener(...args)};wrapper.listener=listener;return this.on(name,wrapper)}
  off(name,listener){super.removeListener(name,listener);if(name==='message'&&!this.listenerCount('message'))this.unref();return this}
  removeListener(name,listener){return this.off(name,listener)}
  removeAllListeners(name){super.removeAllListeners(name);if(name===undefined||name==='message')this.unref();return this}
  ref(){const own=state(this);own.ref=true;host.proc.call('portRef',own.key,true);return this}
  unref(){const own=states.get(this);if(!own||own.closed)return this;own.ref=false;host.proc.call('portRef',own.key,false);return this}
  hasRef(){return states.get(this)?.ref??false}
  addEventListener(name,listener,options={}){
   if(!listener)return
   const entries=eventListeners.get(this)??[];eventListeners.set(this,entries)
   if(entries.some(entry=>entry.name===name&&entry.listener===listener))return
   const wrapper=value=>{if(options?.once)this.removeEventListener(name,listener);const event={type:name,target:this,data:value};typeof listener==='function'?listener.call(this,event):listener.handleEvent(event)}
   entries.push({name,listener,wrapper});this.on(name,wrapper)
  }
  removeEventListener(name,listener){const entries=eventListeners.get(this)??[],index=entries.findIndex(entry=>entry.name===name&&entry.listener===listener);if(index>=0){this.off(name,entries[index].wrapper);entries.splice(index,1)}}
  get onmessage(){return this._onmessage??null}
  set onmessage(listener){if(this._onmessage)this.removeEventListener('message',this._onmessage);this._onmessage=typeof listener==='function'?listener:null;if(this._onmessage)this.addEventListener('message',this._onmessage)}
  close(){const own=states.get(this);if(!own||own.closed)return;this.unref();own.closed=true;adopted.delete(own.key);host.proc.call('routedPortClose',own.key);queueMicrotask(()=>this.emit('close'))}
  get [Symbol.toStringTag](){return 'MessagePort'}
 }
 const adopt=key=>{host.proc.call('routedPortCheck',key);return adopted.get(key)??new MessagePort(key,token)}
 class MessageChannel {constructor(){const [a,b]=host.proc.call('routedPortPair');this.port1=adopt(a);this.port2=adopt(b)}}
 return {
  MessageChannel,MessagePort,
  receiveMessageOnPort(port){const own=state(port);if(own.pending.length)return {message:own.pending.shift()};const delivery=host.proc.call('routedPortTake',own.key);return delivery===null?undefined:{message:consume(own,delivery)}},
  isPort:value=>states.has(value),
  transferId(port){return state(port).key},
  detach(port){const own=state(port);port.unref();own.closed=true;adopted.delete(own.key);queueMicrotask(()=>port.emit('close'))},
  adopt,
 }
}
