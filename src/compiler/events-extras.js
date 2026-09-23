export function createEventsExtras(Base){
  const captureRejectionSymbol=Symbol.for('nodejs.rejection'),errorMonitor=Symbol.for('events.errorMonitor'),capture=Symbol('capture')
  let captureRejections=false
  const invalid=(name,value)=>Object.assign(new TypeError('The "'+name+'" argument must be of the expected type. Received '+typeof value),{code:'ERR_INVALID_ARG_TYPE'})
  class EventEmitter extends Base {
    constructor(options){super();this[capture]=options?.captureRejections??captureRejections}
    emit(name,...args){if(name==='error'&&this.listenerCount(errorMonitor))super.emit(errorMonitor,...args);return super.emit(name,...args)}
    on(name,listener){
      if(typeof listener!=='function')throw invalid('listener',listener)
      const wrapped=function(...args){const result=Reflect.apply(listener,this,args);if((this[capture]||captureRejections)&&result&&typeof result.then==='function')result.catch(error=>queueMicrotask(()=>{if(typeof this[captureRejectionSymbol]==='function')this[captureRejectionSymbol](error,name,...args);else this.emit('error',error)}));return result}
      wrapped.listener=listener;(this.__eventWrappers??=new Map()).set(listener,wrapped);return super.on(name,wrapped)
    }
    addListener(name,listener){return this.on(name,listener)}
    removeListener(name,listener){const wrapped=super.rawListeners?.(name).find(value=>value===listener||value.listener===listener)??listener;super.removeListener(name,wrapped);return this}
    off(name,listener){return this.removeListener(name,listener)}
    listeners(name){return super.listeners(name).map(listener=>listener.listener??listener)}
  }
  for(const name of Object.getOwnPropertyNames(Base))if(!['length','name','prototype','captureRejections','defaultMaxListeners'].includes(name))Object.defineProperty(EventEmitter,name,Object.getOwnPropertyDescriptor(Base,name))
  Object.defineProperty(EventEmitter,'captureRejections',{get:()=>captureRejections,set:value=>{if(typeof value!=='boolean')throw invalid('EventEmitter.captureRejections',value);captureRejections=value}})
  Object.defineProperty(EventEmitter,'defaultMaxListeners',{get:()=>Base.defaultMaxListeners,set:value=>{if(typeof value!=='number'||value<0||Number.isNaN(value))throw Object.assign(new RangeError('Invalid defaultMaxListeners'),{code:'ERR_OUT_OF_RANGE'});Base.defaultMaxListeners=value}})
  EventEmitter.captureRejectionSymbol=captureRejectionSymbol;EventEmitter.errorMonitor=errorMonitor
  const getEventListeners=(target,name)=>{if(typeof target?.listeners!=='function')throw invalid('emitter',target);return target.listeners(name)}
  const getMaxListeners=target=>{if(typeof target?.getMaxListeners!=='function')throw invalid('emitter',target);return target.getMaxListeners()}
  const setMaxListeners=(count,...targets)=>{if(typeof count!=='number'||count<0||Number.isNaN(count))throw Object.assign(new RangeError('Invalid max listeners'),{code:'ERR_OUT_OF_RANGE'});if(!targets.length){EventEmitter.defaultMaxListeners=count;return}for(const target of targets){if(typeof target?.setMaxListeners!=='function')throw invalid('eventTargets',target);target.setMaxListeners(count)}}
  const addAbortListener=(signal,listener)=>{
    if(!signal||typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function')throw invalid('signal',signal)
    if(typeof listener!=='function')throw invalid('listener',listener)
    let active=true;const run=()=>{if(active){active=false;listener()}}
    if(signal.aborted)queueMicrotask(run);else signal.addEventListener('abort',run,{once:true})
    return {[Symbol.dispose](){if(active){active=false;signal.removeEventListener('abort',run)}}}
  }
  const on=(emitter,name,options={})=>{
    if(typeof emitter?.on!=='function'||typeof emitter?.removeListener!=='function')throw invalid('emitter',emitter)
    const signal=options.signal,close=options.close??[],high=options.highWaterMark??Number.MAX_SAFE_INTEGER,low=options.lowWaterMark??1
    if(signal!==undefined&&(!signal||typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'))throw invalid('signal',signal)
    if(!Number.isInteger(high)||high<1||!Number.isInteger(low)||low<1||low>high)throw Object.assign(new RangeError('Invalid event iterator watermarks'),{code:'ERR_OUT_OF_RANGE'})
    let ended=false,error,waiting;const queue=[]
    const wake=()=>{const value=waiting;waiting=undefined;value?.()}
    const event=(...args)=>{queue.push(args);if(queue.length>high)emitter.pause?.();wake()}
    const fail=value=>{error=value;ended=true;wake()},finish=()=>{ended=true;wake()}
    emitter.on(name,event);if(name!=='error')emitter.on('error',fail);for(const value of close)emitter.on(value,finish)
    const abort=()=>fail(Object.assign(Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR',cause:signal.reason}));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
    const cleanup=()=>{emitter.removeListener(name,event);if(name!=='error')emitter.removeListener('error',fail);for(const value of close)emitter.removeListener(value,finish);signal?.removeEventListener('abort',abort)}
    return {async next(){while(!queue.length&&!ended)await new Promise(resolve=>waiting=resolve);if(queue.length){const value=queue.shift();if(queue.length<=low)emitter.resume?.();return {value,done:false}}cleanup();if(error)throw error;return {value:undefined,done:true}},async return(){ended=true;cleanup();return {value:undefined,done:true}},[Symbol.asyncIterator](){return this}}
  }
  return {EventEmitter,addAbortListener,captureRejectionSymbol,errorMonitor,getEventListeners,getMaxListeners,setMaxListeners,on,init:Base.init,usingDomains:false}
}
