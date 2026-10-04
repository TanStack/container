import {EventEmitter} from '../vite-browser/node-events'
import {keepNodeCommandAlive} from '../vite-browser/node-timers'
const adaptedPorts=new WeakSet<object>()
/** Restore Node methods without replacing structured-cloned port identities. */
export function adaptTransferredPorts<T>(value:T):T{
  const seen=new WeakSet<object>()
  const visit=(item:unknown):void=>{
    if(!item||typeof item!=='object'||seen.has(item))return
    seen.add(item)
    if(typeof globalThis.MessagePort==='function'&&item instanceof globalThis.MessagePort){nodeMessagePort(item);return}
    if(item instanceof Map){for(const [key,value] of item){visit(key);visit(value)};return}
    if(item instanceof Set){for(const value of item)visit(value);return}
    if(Array.isArray(item)||Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null)
      for(const value of Object.values(item))visit(value)
  }
  visit(value);return value
}

export function nodeMessagePort<T extends globalThis.MessagePort>(port:T):T & EventEmitter & {ref():void;unref():void;hasRef():boolean}{
  if(adaptedPorts.has(port))return port as T & EventEmitter & {ref():void;unref():void;hasRef():boolean}
  adaptedPorts.add(port)
  const events=new EventEmitter()
  const listeners=new WeakMap<Function,(...args:any[])=>void>()
  let release:(()=>void)|undefined
  let closed=false
  const ref=()=>{if(!closed&&!release)release=keepNodeCommandAlive()}
  const unref=()=>{release?.();release=undefined}
  const close=port.close.bind(port)
  port.addEventListener('message',event=>events.emit('message',adaptTransferredPorts(event.data)))
  port.addEventListener('messageerror',event=>events.emit('messageerror',event))
  const onRemoved=(event:string)=>{
    if(event==='message'&&!events.listenerCount('message'))unref()
  }
  events.on('removeListener',onRemoved)
  for(const name of ['on','once','addListener'] as const){
    Object.defineProperty(port,name,{value:(event:string,listener:(...args:any[])=>void)=>{
      if(typeof listener!=='function')throw new TypeError('Listener must be a function')
      let bound=listeners.get(listener)
      if(!bound){bound=(...args:any[])=>Reflect.apply(listener,port,args);listeners.set(listener,bound)}
      const firstMessageListener=event==='message'&&!events.listenerCount('message')
      events[name](event,bound)
      if(firstMessageListener&&!closed){port.start();ref()}
      return port
    }})
  }
  for(const name of ['off','removeListener','removeAllListeners'] as const)
    Object.defineProperty(port,name,{value:(...args:any[])=>{
      if(name!=='removeAllListeners'&&typeof args[1]==='function')args[1]=listeners.get(args[1])??args[1]
      Reflect.apply(events[name],events,args)
      if(name==='removeAllListeners'&&!events.listeners('removeListener').includes(onRemoved))
        events.on('removeListener',onRemoved)
      return port
    }})
  Object.defineProperties(port,{
    ref:{value:ref},unref:{value:unref},hasRef:{value:()=>!closed&&!!release},
    close:{value:()=>{
      if(closed)return
      closed=true
      close()
      queueMicrotask(()=>{try{events.emit('close')}finally{events.removeAllListeners()}})
      unref()
    }},
  })
  return port as T & EventEmitter & {ref():void;unref():void;hasRef():boolean}
}

export class MessageChannel{
  readonly port1:ReturnType<typeof nodeMessagePort>
  readonly port2:ReturnType<typeof nodeMessagePort>
  constructor(){
    const channel=new globalThis.MessageChannel()
    this.port1=nodeMessagePort(channel.port1)
    this.port2=nodeMessagePort(channel.port2)
  }
}
export const MessagePort=globalThis.MessagePort
