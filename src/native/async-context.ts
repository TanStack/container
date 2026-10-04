// Browser-native async context for compiled modules. Native await and dynamic
// code remain outside this adapter's coverage, so this is not Node ALS parity.
import {isNativeProcessExit} from './process-exit'
type Frame=Map<NativeAsyncLocalStorage<unknown>,unknown>
let frame:Frame|undefined
let installed=false
let nextResourceId=1
let currentResourceId=0

export class NativeAsyncResource{
  readonly #frame=frame
  readonly #id=nextResourceId++
  readonly #triggerId:number
  constructor(type:string,options:number|{triggerAsyncId?:number;requireManualDestroy?:boolean}={}){
    if(typeof type!=='string')throw new TypeError('AsyncResource type must be a string')
    this.#triggerId=typeof options==='number'?options:options.triggerAsyncId??currentResourceId
    if(!Number.isSafeInteger(this.#triggerId)||this.#triggerId< -1)throw new RangeError('Invalid triggerAsyncId')
  }
  asyncId(){return this.#id}
  triggerAsyncId(){return this.#triggerId}
  runInAsyncScope<T>(callback:(...args:any[])=>T,receiver:unknown,...args:any[]):T{
    const previous=currentResourceId
    currentResourceId=this.#id
    try{return invoke(this.#frame,callback,receiver,args)}
    finally{currentResourceId=previous}
  }
  bind<T extends (...args:any[])=>any>(callback:T,receiver?:unknown):T{
    const resource=this
    const explicitReceiver=arguments.length>1
    return function(this:unknown,...args:any[]){
      return resource.runInAsyncScope(callback,explicitReceiver?receiver:this,...args)
    } as T
  }
  emitDestroy(){return this}
  static bind<T extends (...args:any[])=>any>(callback:T,type='bound-anonymous-fn',receiver?:unknown):T{
    const resource=new NativeAsyncResource(type)
    return arguments.length>2?resource.bind(callback,receiver):resource.bind(callback)
  }
}

export function executionAsyncId(){return currentResourceId}

function invoke<T>(captured:Frame|undefined,callback:(...args:any[])=>T,receiver:unknown,args:any[]):T{
  const previous=frame
  frame=captured
  try{return Reflect.apply(callback,receiver,args)}
  finally{frame=previous}
}

function bind<T>(callback:T):T{
  if(typeof callback!=='function')return callback
  const captured=frame
  return function(this:unknown,...args:any[]){return invoke(captured,callback as (...args:any[])=>unknown,this,args)} as T
}

export class NativeAsyncLocalStorage<T=unknown>{
  readonly #defaultValue:T|undefined
  readonly name:string
  constructor(options:{defaultValue?:T;name?:string}={}){
    this.#defaultValue=options.defaultValue
    this.name=options.name===undefined?'':String(options.name)
  }
  getStore():T|undefined{
    return (frame?.has(this as NativeAsyncLocalStorage<unknown>)
      ? frame.get(this as NativeAsyncLocalStorage<unknown>)
      : this.#defaultValue) as T|undefined
  }
  enterWith(value:T){frame=new Map(frame).set(this as NativeAsyncLocalStorage<unknown>,value)}
  run<R>(value:T,callback:(...args:any[])=>R,...args:any[]):R{
    const previous=frame
    this.enterWith(value)
    try{return Reflect.apply(callback,null,args)}
    finally{frame=previous}
  }
  exit<R>(callback:(...args:any[])=>R,...args:any[]):R{
    return this.run(undefined as T,callback,...args)
  }
  disable(){frame?.delete(this as NativeAsyncLocalStorage<unknown>)}
  static bind<T extends (...args:any[])=>any>(callback:T):T{return bind(callback)}
  static snapshot(){
    const captured=frame
    return <T>(callback:(...args:any[])=>T,...args:any[])=>invoke(captured,callback,undefined,args)
  }
}

export function installNativeAsyncContext(){
  if(installed)return
  installed=true
  const originalThen=Promise.prototype.then
  Promise.prototype.then=function(this:Promise<unknown>,fulfilled,rejected){
    const boundRejected=bind(rejected)
    return originalThen.call(this,bind(fulfilled),typeof boundRejected==='function'
      ? function(this:unknown,reason:unknown){
          // process.exit() terminates a Node process, so its internal signal
          // must not enter a project's catch handler.
          if(isNativeProcessExit(reason))return new Promise<never>(()=>{})
          return Reflect.apply(boundRejected,this,[reason])
        }
      :boundRejected)
  } as typeof Promise.prototype.then
  for(const name of ['setTimeout','setInterval','queueMicrotask'] as const){
    const original=globalThis[name] as (...args:any[])=>unknown
    ;(globalThis as unknown as Record<string,unknown>)[name]=(callback:Function,...args:unknown[])=>original(bind(callback),...args)
  }
  Object.defineProperty(globalThis,'__engineAsyncLocalStorage',{value:NativeAsyncLocalStorage,configurable:true})
}
