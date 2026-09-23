// All objects in this module belong to the guest realm. No browser objects cross
// the VM boundary. The task scheduler is installed by the kernel before use.
const eventState = new WeakMap()
const customEventState = new WeakMap()
const targetState = new WeakMap()
const signalState = new WeakMap()
const signalToken = {}

export class DOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(String(message))
    this.name = String(name)
  }
  get code() { return ({InvalidStateError:11, SyntaxError:12, InvalidAccessError:15, SecurityError:18, NetworkError:19, AbortError:20, TimeoutError:23, DataCloneError:25})[this.name] ?? 0 }
  get [Symbol.toStringTag]() { return 'DOMException' }
}

export class Event {
  constructor(type, options = {}) {
    if(arguments.length===0)throw new TypeError('Event type is required')
    eventState.set(this, {type:String(type), bubbles:!!options.bubbles, cancelable:!!options.cancelable,
      composed:!!options.composed, target:null, currentTarget:null, canceled:false, stopped:false, immediate:false,
      dispatching:false, passive:false, timeStamp:globalThis.performance?.now?.() ?? Date.now()})
  }
  get type(){return eventState.get(this).type}
  get bubbles(){return eventState.get(this).bubbles}
  get cancelable(){return eventState.get(this).cancelable}
  get composed(){return eventState.get(this).composed}
  get target(){return eventState.get(this).target}
  get currentTarget(){return eventState.get(this).currentTarget}
  get defaultPrevented(){return eventState.get(this).canceled}
  get eventPhase(){return eventState.get(this).dispatching?2:0}
  get timeStamp(){return eventState.get(this).timeStamp}
  get isTrusted(){return false}
  get cancelBubble(){return eventState.get(this).stopped}
  set cancelBubble(value){if(value)this.stopPropagation()}
  get returnValue(){return !this.defaultPrevented}
  set returnValue(value){if(!value)this.preventDefault()}
  preventDefault(){const s=eventState.get(this);if(s.cancelable&&!s.passive)s.canceled=true}
  stopPropagation(){eventState.get(this).stopped=true}
  stopImmediatePropagation(){const s=eventState.get(this);s.immediate=s.stopped=true}
  composedPath(){const s=eventState.get(this);return s.dispatching?[s.target]:[]}
  get [Symbol.toStringTag](){return 'Event'}
}

export class CustomEvent extends Event {
  constructor(type, options = {}) {
    super(type, options)
    customEventState.set(this, 'detail' in options ? options.detail : null)
  }
  get detail(){return customEventState.get(this)}
  get [Symbol.toStringTag](){return 'CustomEvent'}
}

export class EventTarget {
  constructor(){targetState.set(this,[])}
  [Symbol.for('sandbox:event-listeners')](){
    const listeners=targetState.get(this)
    if(!listeners)throw new TypeError('Invalid EventTarget receiver')
    return listeners.map(({type,callback,capture})=>({type,callback,capture}))
  }
  addEventListener(type, callback, options = {}) {
    if(callback==null)return
    if(typeof callback!=='function'&&typeof callback!=='object')throw new TypeError('Invalid event listener')
    type=String(type)
    if(typeof options==='boolean')options={capture:options}
    options??={}
    const capture=!!options.capture, listeners=targetState.get(this)
    if(!listeners)throw new TypeError('Invalid EventTarget receiver')
    if(options.signal!==undefined&&!signalState.has(options.signal))throw new TypeError('Expected AbortSignal')
    if(options.signal?.aborted||listeners.some(l=>l.type===type&&l.callback===callback&&l.capture===capture))return
    const listener={type,callback,capture,once:!!options.once,passive:!!options.passive,cleanup:undefined}
    if(options.signal)listener.cleanup=addAbortAlgorithm(options.signal,()=>this.removeEventListener(type,callback,capture))
    listeners.push(listener)
  }
  removeEventListener(type,callback,options = {}) {
    const listeners=targetState.get(this),capture=typeof options==='boolean'?options:!!options?.capture
    if(!listeners)throw new TypeError('Invalid EventTarget receiver')
    const index=listeners.findIndex(l=>l.type===String(type)&&l.callback===callback&&l.capture===capture)
    if(index!==-1){const [listener]=listeners.splice(index,1);listener.cleanup?.()}
  }
  dispatchEvent(event){
    const state=eventState.get(event),listeners=targetState.get(this)
    if(!state||!listeners)throw new TypeError('Expected guest Event and EventTarget')
    if(state.dispatching)throw new DOMException('Event is already being dispatched','InvalidStateError')
    state.dispatching=true;state.target=state.currentTarget=this;state.immediate=state.stopped=false
    try{
      for(const listener of [...listeners]){
        if(state.immediate)break
        if(listener.type!==event.type||!listeners.includes(listener))continue
        if(listener.once)this.removeEventListener(listener.type,listener.callback,listener.capture)
        state.passive=listener.passive
        try{
          if(typeof listener.callback==='function')listener.callback.call(this,event)
          else listener.callback.handleEvent?.call(listener.callback,event)
        }catch(error){reportException(error)}
      }
    }finally{state.currentTarget=null;state.dispatching=state.passive=state.immediate=state.stopped=false}
    return !state.canceled
  }
  get [Symbol.toStringTag](){return 'EventTarget'}
}
function reportException(error){
  if(globalThis.__webContainerHost?.reportError)globalThis.__webContainerHost.reportError(error)
  else queueMicrotask(()=>{throw error})
}
function eventHandler(prototype,name){
  const values=new WeakMap()
  Object.defineProperty(prototype,'on'+name,{configurable:true,enumerable:true,
    get(){return values.get(this)?.callback??null},
    set(callback){
      let record=values.get(this)
      if(typeof callback!=='function'){
        if(record)this.removeEventListener(name,record.listener)
        values.delete(this);return
      }
      if(record){record.callback=callback;return}
      record={callback,listener:event=>record.callback.call(this,event)}
      values.set(this,record);this.addEventListener(name,record.listener)
    },
  })
}
function addAbortAlgorithm(signal,algorithm){
  const state=signalState.get(signal)
  if(!state)throw new TypeError('Expected AbortSignal')
  state.algorithms.add(algorithm)
  return ()=>state.algorithms.delete(algorithm)
}
function abort(signal,reason){
  const pending=[]
  function mark(current){
    const state=signalState.get(current)
    if(state.aborted)return
    state.aborted=true;state.reason=reason;pending.push(current)
    for(const dependent of state.dependents)mark(dependent)
  }
  mark(signal)
  for(const current of pending){
    const state=signalState.get(current)
    for(const source of state.sources)signalState.get(source).dependents.delete(current)
    state.sources.clear();state.dependents.clear()
    for(const algorithm of state.algorithms)algorithm()
    state.algorithms.clear();current.dispatchEvent(new Event('abort'))
  }
}
export class AbortSignal extends EventTarget {
  constructor(token){
    if(token!==signalToken)throw new TypeError('Illegal constructor')
    super();signalState.set(this,{aborted:false,reason:undefined,algorithms:new Set(),sources:new Set(),dependents:new Set()})
  }
  get aborted(){return signalState.get(this).aborted}
  get reason(){return signalState.get(this).reason}
  throwIfAborted(){if(this.aborted)throw this.reason}
  static abort(reason=new DOMException('This operation was aborted','AbortError')){
    const signal=new AbortSignal(signalToken);abort(signal,reason);return signal
  }
  static timeout(delay){
    if(typeof delay!=='number'||!Number.isInteger(delay)||delay<0||delay>0xffffffff)throw new RangeError('Invalid timeout')
    const signal=new AbortSignal(signalToken)
    const timer=setTimeout(()=>abort(signal,new DOMException('The operation was aborted due to timeout','TimeoutError')),delay)
    timer?.unref?.()
    return signal
  }
  static any(signals){
    if(!Array.isArray(signals)||signals.some(s=>!signalState.has(s)))throw new TypeError('Expected an array of AbortSignals')
    const result=new AbortSignal(signalToken)
    const first=signals.find(s=>s.aborted)
    if(first){abort(result,first.reason);return result}
    for(const source of new Set(signals)){signalState.get(source).dependents.add(result);signalState.get(result).sources.add(source)}
    return result
  }
  get [Symbol.toStringTag](){return 'AbortSignal'}
}
eventHandler(AbortSignal.prototype,'abort')
export class AbortController {
  #signal=new AbortSignal(signalToken)
  get signal(){return this.#signal}
  abort(reason=new DOMException('This operation was aborted','AbortError')){abort(this.#signal,reason)}
  get [Symbol.toStringTag](){return 'AbortController'}
}

export function structuredClone(value,options={}){
  if(options.transfer?.length)throw new DOMException('Transfer lists are not supported by the guest yet','NotSupportedError')
  const seen=new Map()
  function clone(value){
    if(typeof value==='function'||typeof value==='symbol')throw new DOMException('Value cannot be cloned','DataCloneError')
    if(value===null||typeof value!=='object')return value
    if(seen.has(value))return seen.get(value)
    if(value instanceof Promise||value instanceof WeakMap||value instanceof WeakSet||value instanceof EventTarget)throw new DOMException('Value cannot be cloned','DataCloneError')
    let copy
    if(value instanceof ArrayBuffer){copy=value.slice(0);seen.set(value,copy);return copy}
    if(ArrayBuffer.isView(value)){
      const buffer=clone(value.buffer)
      const Constructor=[Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array].find(Type=>value instanceof Type)
      copy=value instanceof DataView?new DataView(buffer,value.byteOffset,value.byteLength):new Constructor(buffer,value.byteOffset,value.length)
    }else if(value instanceof Date)copy=new Date(value.getTime())
    else if(value instanceof RegExp)copy=new RegExp(value.source,value.flags)
    else if(value instanceof Map){copy=new Map();seen.set(value,copy);for(const [k,v] of value)copy.set(clone(k),clone(v));return copy}
    else if(value instanceof Set){copy=new Set();seen.set(value,copy);for(const v of value)copy.add(clone(v));return copy}
    else if(value instanceof Error){
      const Constructor=({Error,TypeError,RangeError,ReferenceError,SyntaxError,URIError,EvalError})[value.name]??Error
      copy=new Constructor(value.message);seen.set(value,copy)
      if('cause' in value)copy.cause=clone(value.cause)
      if(typeof value.stack==='string')copy.stack=value.stack
      return copy
    }else{
      copy=Array.isArray(value)?new Array(value.length):{}
      seen.set(value,copy)
      for(const key of Object.keys(value))Object.defineProperty(copy,key,{value:clone(value[key]),writable:true,enumerable:true,configurable:true})
      return copy
    }
    seen.set(value,copy);return copy
  }
  return clone(value)
}

const ports=new WeakMap()
const portToken={}
export class MessageEvent extends Event {
  constructor(type,options={}){super(type,options);this.data='data' in options?options.data:null;this.origin=options.origin??'';this.lastEventId=options.lastEventId??'';this.source=options.source??null;this.ports=options.ports??[]}
  get [Symbol.toStringTag](){return 'MessageEvent'}
}
function schedule(port){
  const state=ports.get(port)
  if(state.closed||!state.started||state.timer||!state.queue.length)return
  state.timer=setTimeout(()=>{
    state.timer=null
    if(state.closed)return
    const value=state.queue.shift()
    state.run(()=>port.dispatchEvent(new MessageEvent('message',{data:value})))
    schedule(port)
  },0)
  if(!state.ref)state.timer?.unref?.()
}
export function receiveMessageOnPort(port){
  const state=ports.get(port)
  if(!state)throw Object.assign(new TypeError('The port argument must be a MessagePort'),{code:'ERR_INVALID_ARG_TYPE'})
  if(!state.queue.length)return undefined
  const message=state.queue.shift()
  // A consumed message must not also produce an event, including an undefined
  // event from a previously scheduled delivery after the queue becomes empty.
  if(!state.queue.length&&state.timer){clearTimeout(state.timer);state.timer=null}
  return {message}
}
export class MessagePort extends EventTarget {
  constructor(token){if(token!==portToken)throw new TypeError('Illegal constructor');super();ports.set(this,{peer:null,closed:false,started:false,queue:[],timer:null,ref:true,run:globalThis.__webContainerHost?.AsyncLocalStorage?.snapshot()??(fn=>fn())})}
  postMessage(value,transfer=[]){
    const state=ports.get(this),copy=structuredClone(value,Array.isArray(transfer)?{transfer}:transfer)
    if(state.closed||!state.peer)return
    const peer=ports.get(state.peer)
    if(peer.closed)return
    if(peer.queue.length>=256)throw new DOMException('Message queue limit exceeded','QuotaExceededError')
    peer.queue.push(copy);schedule(state.peer)
  }
  start(){const state=ports.get(this);if(!state.closed){state.started=true;schedule(this)}}
  close(){const state=ports.get(this);if(state.closed)return;state.closed=true;if(state.timer)clearTimeout(state.timer);state.timer=null;state.peer=null;setTimeout(()=>{state.queue.length=0},0)}
  ref(){const state=ports.get(this);state.ref=true;state.timer?.ref?.();return this}
  unref(){const state=ports.get(this);state.ref=false;state.timer?.unref?.();return this}
  get [Symbol.toStringTag](){return 'MessagePort'}
}
eventHandler(MessagePort.prototype,'message');eventHandler(MessagePort.prototype,'messageerror')
const messageHandler=Object.getOwnPropertyDescriptor(MessagePort.prototype,'onmessage')
Object.defineProperty(MessagePort.prototype,'onmessage',{...messageHandler,set(value){messageHandler.set.call(this,value);if(typeof value==='function')this.start()}})
export class MessageChannel {
  constructor(){const port1=new MessagePort(portToken),port2=new MessagePort(portToken);ports.get(port1).peer=port2;ports.get(port2).peer=port1;Object.defineProperties(this,{port1:{value:port1,enumerable:true},port2:{value:port2,enumerable:true}})}
  get [Symbol.toStringTag](){return 'MessageChannel'}
}
