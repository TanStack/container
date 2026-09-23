/** Guest-only adapter. All callbacks run in guest Promise continuations, never
 * by a host callFunction while the compiler is waiting. */
export function createGuestBundlerAdapter(transport,scopeStore,restoreBindingResult,{maxBytes,maxCallbacks=1024}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxCallbacks)||maxCallbacks<1)throw Error('Invalid guest bundler limits')
  let callbackSequence=0
  const pendingStarts=[],pendingReleases=[]
  const unsupported=method=>Object.assign(Error('Native plugin context method is not supported: '+method),{code:'ERR_UNSUPPORTED_OPERATION'})
  function bounded(value){if(new TextEncoder().encode(JSON.stringify(value)).byteLength>maxBytes)throw Error('Guest bundler payload exceeds owner byte limit');return value}
  function encode(value,register,ancestors=new Set(),depth=0){
    if(depth>32)throw Error('Guest bundler value exceeds depth bound')
    if(value===undefined)return {type:'undefined'}
    if(value===null||typeof value==='string'||typeof value==='boolean')return value
    if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Unsupported guest bundler number');return value}
    if(typeof value==='function'){if(!register)throw Error('Function is not a supported callback result');return {type:'guest-callback',id:register(value)}}
    if(typeof value!=='object')throw Error('Unsupported guest bundler value')
    if(ancestors.has(value))throw Error('Cyclic guest bundler value')
    ancestors.add(value)
    try{
      if(value instanceof RegExp)return {type:'RegExp',source:value.source,flags:value.flags}
      if(value instanceof Uint8Array)return {type:'bytes',value:Array.from(value)}
      if(value instanceof ArrayBuffer)return {type:'bytes',value:Array.from(new Uint8Array(value))}
      if(Array.isArray(value))return value.map(item=>encode(item,register,ancestors,depth+1))
      if(value instanceof Error)return {type:'error',value:encode({...value,name:value.name,message:value.message,stack:value.stack,...('cause'in value?{cause:value.cause}:{})},register,ancestors,depth+1)}
      if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Unsupported guest bundler object')
      if(['undefined','bytes','RegExp','guest-callback','native-context','error'].includes(value.type))throw Error('Reserved guest bundler transport tag')
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item,register,ancestors,depth+1)]))
    }finally{ancestors.delete(value)}
  }
  function decode(value,lifetime,depth=0){
    if(depth>32)throw Error('Native bundler callback exceeds depth bound')
    if(value===null||typeof value!=='object')return value
    if(Array.isArray(value))return value.map(item=>decode(item,lifetime,depth+1))
    if(value instanceof Uint8Array)return value
    if(value.type==='undefined')return undefined
    if(value.type==='bytes')return new Uint8Array(value.value)
    if(value.type==='RegExp')return new RegExp(value.source,value.flags)
    if(value.type==='error')return Object.assign(new Error(),decode(value.value,lifetime,depth+1))
    if(value.type==='native-context'){
      if(value.scope!==lifetime.scope||!Number.isSafeInteger(value.handle)||!Array.isArray(value.methods))throw Error('Invalid native plugin context descriptor')
      const context={}
      const check=()=>{if(!lifetime.active)throw Error('Expired native plugin context')}
      for(const method of value.methods){
        if(method==='inner'){
          if(!value.inner)throw Error('Native plugin context is missing inner descriptor')
          const inner=decode(value.inner,lifetime,depth+1)
          context.inner=()=>{check();return inner}
        }else if(method==='resolve'||method==='load'){
          context[method]=(...args)=>{check();return Promise.resolve(transport.context(value.scope,value.handle,method,bounded(encode(args)))).then(result=>{check();return decode(result,lifetime)})}
        }else context[method]=()=>{check();throw unsupported(method)}
      }
      return context
    }
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,decode(item,lifetime,depth+1)]))
  }
  const BindingBundler=class BindingBundler{
    #handle
    #callbacks=new Map()
    #callbackIds=new WeakMap()
    #active=new Map()
    #closed=false
    #closing
    #watchFiles=[]
    #runtime={started:false}
    constructor(){this.#handle=transport.create();if(!Number.isSafeInteger(this.#handle)||this.#handle<1)throw Error('Invalid guest bundler handle');pendingStarts.push(this.#runtime)}
    get closed(){return this.#closed}
    getWatchFiles(){return [...this.#watchFiles]}
    #register(callback){
      let id=this.#callbackIds.get(callback)
      if(id!==undefined)return id
      if(this.#callbacks.size>=maxCallbacks)throw Error('Guest bundler callback limit')
      id=++callbackSequence;this.#callbackIds.set(callback,id);this.#callbacks.set(id,callback);return id
    }
    #invoke(method,options){
      let operation
      try{operation=transport.start(this.#handle,method,options)}catch(error){return Promise.reject(error)}
      if(!Number.isSafeInteger(operation)||this.#active.has(operation))return Promise.reject(Error('Invalid guest bundler operation id'))
      let rejectCancellation
      const cancellation=new Promise((_,reject)=>{rejectCancellation=reject})
      const record={cancelled:false,promise:undefined,reject:error=>{record.cancelled=true;rejectCancellation(error)}}
      this.#active.set(operation,record)
      let previousCallback=0
      const callbacks=new Set()
      const pump=()=>Promise.race([Promise.resolve().then(()=>{if(record.cancelled)throw Error('Bundler operation cancelled');return transport.next(operation)}),cancellation]).then(async event=>{
        if(event?.type==='result'){await Promise.all(callbacks);return event.value}
        if(event?.type==='error')throw decode(event.error??{type:'error',value:{message:String(event.message)}},{active:false})
        if(event?.type!=='callback'||!Number.isSafeInteger(event.id)||event.id<=previousCallback||!Number.isSafeInteger(event.scope)||typeof event.sync!=='boolean'||!Array.isArray(event.args))throw Error('Invalid guest bundler callback request')
        previousCallback=event.id
        if(callbacks.size>=maxCallbacks)throw Error('Guest bundler concurrent callback limit')
        const task=(async()=>{
        const lifetime={active:true,scope:event.scope}
        let reply
        try{
          const callback=this.#callbacks.get(event.callbackId)
          if(!callback)throw Error('Unknown guest bundler callback')
          const args=decode(event.args,lifetime)
          let value=scopeStore.run(event.scope,()=>Reflect.apply(callback,undefined,args))
          if(event.sync){
            if(value&&typeof value.then==='function'){
              Promise.resolve(value).catch(error=>transport.reportError(String(error)))
              throw Error('Synchronous native bundler callback returned a Promise')
            }
          }else value=await Promise.race([Promise.resolve(value),cancellation])
          reply={type:'value',value:bounded(encode(value))}
        }catch(error){reply={type:'error',error:bounded(encode(error instanceof Error?error:new Error(String(error))))}}
        finally{lifetime.active=false}
        if(record.cancelled)throw Error('Bundler operation cancelled')
        transport.reply(operation,event.id,reply)
        })()
        callbacks.add(task)
        task.then(()=>callbacks.delete(task),error=>{callbacks.delete(task);record.reject(error)})
        return pump()
      })
      record.promise=pump().catch(async error=>{record.reject(error);try{transport.cancel(operation)}catch(cancelError){transport.reportError(String(cancelError))}await Promise.allSettled(callbacks);throw error}).finally(()=>{this.#active.delete(operation);transport.finish(operation)})
      return record.promise
    }
    async #run(method,options){
      if(this.#closed||this.#closing)throw Error('Bundler is closed')
      const result=await this.#invoke(method,bounded(encode(options,callback=>this.#register(callback))))
      if(!result||!Array.isArray(result.watchFiles)||typeof result.closed!=='boolean')throw Error('Invalid native bundler result')
      this.#watchFiles=[...result.watchFiles];this.#closed=result.closed
      return method==='scan'&&result.result===undefined?undefined:restoreBindingResult(result.result)
    }
    generate(options){return this.#run('generate',options)}
    write(options){return this.#run('write',options)}
    scan(options){return this.#run('scan',options)}
    close(){
      if(this.#closing)return this.#closing
      if(this.#closed)return Promise.resolve()
      const pending=[...this.#active.values()].map(record=>record.promise)
      for(const [operation,record]of this.#active){
        record.reject(Error('Bundler operation cancelled by close'))
        try{transport.cancel(operation)}catch(error){transport.reportError(String(error))}
      }
      this.#closing=Promise.allSettled(pending).then(()=>this.#invoke('close',undefined)).then(()=>{this.#closed=true}).finally(()=>{
        this.#callbacks.clear()
        if(this.#runtime.started)pendingReleases.push(this.#runtime)
        else{const index=pendingStarts.indexOf(this.#runtime);if(index>=0)pendingStarts.splice(index,1)}
      })
      return this.#closing
    }
  }
  // These pair the unmodified JS wrapper's notifications only. The owner starts
  // the actual native runtime on create and releases it on close, including errors.
  BindingBundler.startAsyncRuntime=()=>{
    const record=pendingStarts.shift()
    if(!record)throw unsupported('startAsyncRuntime without an adapted BindingBundler')
    record.started=true
  }
  BindingBundler.shutdownAsyncRuntime=()=>{
    if(!pendingReleases.shift())throw unsupported('shutdownAsyncRuntime without a settled adapted close')
  }
  BindingBundler.unsupportedRuntimeConstructor=name=>function(){throw unsupported(name)}
  return BindingBundler
}
