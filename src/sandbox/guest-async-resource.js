// Resource identity is scoped to one guest module graph. User AsyncLocalStorage
// snapshots cross awaits, while AsyncResource execution identity is only active
// during the synchronous runInAsyncScope call that creates those continuations.
export function createAsyncResources(AsyncLocalStorage){
  const states=new WeakMap()
  let active
  let nextId=1
  const executionAsyncId=()=>active?.id??0
  const triggerAsyncId=()=>active?.trigger??0
  const executionAsyncResource=()=>active?.resource??globalThis
  class AsyncResource {
    constructor(type,options={}){
      if(typeof type!=='string')throw Object.assign(new TypeError('type must be a string'),{code:'ERR_INVALID_ARG_TYPE'})
      if(typeof options==='number')options={triggerAsyncId:options}
      if(!options||typeof options!=='object')throw Object.assign(new TypeError('options must be an object'),{code:'ERR_INVALID_ARG_TYPE'})
      const trigger=options.triggerAsyncId??executionAsyncId()
      if(!Number.isSafeInteger(trigger)||trigger< -1)throw Object.assign(new RangeError('Invalid triggerAsyncId'),{code:'ERR_INVALID_ASYNC_ID'})
      if(options.requireManualDestroy!==undefined&&typeof options.requireManualDestroy!=='boolean')throw Object.assign(new TypeError('requireManualDestroy must be a boolean'),{code:'ERR_INVALID_ARG_TYPE'})
      states.set(this,{id:nextId++,trigger,snapshot:AsyncLocalStorage.snapshot(),destroyed:false})
    }
    runInAsyncScope(fn,thisArg,...args){
      if(typeof fn!=='function')throw Object.assign(new TypeError('fn must be a function'),{code:'ERR_INVALID_ARG_TYPE'})
      const state=states.get(this)
      return state.snapshot(()=>{
        const previous=active
        active={id:state.id,trigger:state.trigger,resource:this}
        try{return Reflect.apply(fn,thisArg,args)}finally{active=previous}
      })
    }
    bind(fn,thisArg){
      if(typeof fn!=='function')throw Object.assign(new TypeError('fn must be a function'),{code:'ERR_INVALID_ARG_TYPE'})
      const resource=this,receiverProvided=arguments.length>1
      const bound=function(...args){return resource.runInAsyncScope(fn,receiverProvided?thisArg:this,...args)}
      Object.defineProperty(bound,'length',{value:fn.length,configurable:true})
      return bound
    }
    static bind(fn,type,thisArg){
      const resource=new AsyncResource(type??fn.name??'bound-anonymous-fn')
      return arguments.length>2?resource.bind(fn,thisArg):resource.bind(fn)
    }
    asyncId(){return states.get(this).id}
    triggerAsyncId(){return states.get(this).trigger}
    // No createHook API is exposed yet. Destroy marks the notification lifecycle,
    // it does not prevent later scope entry, matching Node's resource behavior.
    emitDestroy(){states.get(this).destroyed=true;return this}
  }
  return {AsyncResource,executionAsyncId,triggerAsyncId,executionAsyncResource}
}

export function createAsyncEmitter(EventEmitter,AsyncResource){
  return class EventEmitterAsyncResource extends EventEmitter {
    #resource
    constructor(options){
      let name
      if(typeof options==='string'){name=options;options=undefined}
      else{
        if(new.target===EventEmitterAsyncResource&&typeof options?.name!=='string')throw Object.assign(new TypeError('options.name must be a string'),{code:'ERR_INVALID_ARG_TYPE'})
        name=options?.name||new.target.name
      }
      super(options)
      this.#resource=new AsyncResource(name,options)
      Object.defineProperty(this.#resource,'eventEmitter',{get:()=>this})
    }
    emit(event,...args){return this.#resource.runInAsyncScope(super.emit,this,event,...args)}
    emitDestroy(){this.#resource.emitDestroy()}
    get asyncId(){return this.#resource.asyncId()}
    get triggerAsyncId(){return this.#resource.triggerAsyncId()}
    get asyncResource(){return this.#resource}
  }
}
