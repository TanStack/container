export function nodeMessagePorts(BaseChannel,BasePort){
  if(!BaseChannel||!BasePort)return {MessageChannel:BaseChannel,MessagePort:BasePort}
  const listeners=new WeakMap()
  const identities=new WeakMap()
  const closed=new WeakSet()
  let nextId=1
  const setReference=(port,ref)=>globalThis.__webContainerHost?.proc?.call('portRef',identities.get(port),ref)
  class MessagePort extends BasePort {
    ref(){super.ref();if(!closed.has(this))setReference(this,true);return this}
    unref(){super.unref();setReference(this,false);return this}
    close(){super.close();closed.add(this);setReference(this,false)}
    on(name,listener){return this._add(name,listener,false)}
    addListener(name,listener){return this.on(name,listener)}
    once(name,listener){return this._add(name,listener,true)}
    _add(name,listener,once){
      if(typeof listener!=='function')throw new TypeError('Listener must be a function')
      const entries=listeners.get(this)
      if(entries.some(entry=>entry.name===name&&entry.listener===listener))return this
      const entry={name,listener,wrapper:null}
      entry.wrapper=event=>{
        if(once)this._remove(entry)
        listener.call(this,name==='message'?event.data:event)
      }
      entries.push(entry);this.addEventListener(name,entry.wrapper)
      if(name==='message'){this.start();this.ref()}
      return this
    }
    _remove(entry){
      const entries=listeners.get(this),index=entries.indexOf(entry)
      if(index>=0){entries.splice(index,1);this.removeEventListener(entry.name,entry.wrapper)}
      if(entry.name==='message'&&!entries.some(value=>value.name==='message'))this.unref()
    }
    off(name,listener){
      const entry=listeners.get(this).findLast(value=>value.name===name&&value.listener===listener)
      if(entry)this._remove(entry)
      return this
    }
    removeListener(name,listener){return this.off(name,listener)}
    removeAllListeners(name){
      for(const entry of [...listeners.get(this)])if(name===undefined||entry.name===name)this._remove(entry)
      for(const entry of this[Symbol.for('sandbox:event-listeners')]())if(name===undefined||entry.type===name)this.removeEventListener(entry.type,entry.callback,entry.capture)
      return this
    }
    listeners(name){return this[Symbol.for('sandbox:event-listeners')]().filter(entry=>entry.type===name).map(entry=>listeners.get(this).find(value=>value.wrapper===entry.callback)?.listener??entry.callback)}
    listenerCount(name){return this.listeners(name).length}
    eventNames(){return [...new Set(this[Symbol.for('sandbox:event-listeners')]().map(entry=>entry.type))]}
  }
  // Retain the base channel's private peer state and add Node listener methods.
  class MessageChannel {
    constructor(){
      const channel=new BaseChannel()
      for(const key of ['port1','port2']){
        const port=channel[key]
        Object.setPrototypeOf(port,MessagePort.prototype);listeners.set(port,[])
        identities.set(port,nextId++)
        Object.defineProperty(this,key,{value:port,enumerable:true})
      }
    }
  }
  return {MessageChannel,MessagePort}
}
