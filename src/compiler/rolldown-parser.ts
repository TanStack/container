import {rolldownParserPolicy,type RolldownCompilerProfile,type RolldownParserPolicy} from './rolldown-parser-policy'
import {callableCallbackNames,callableLimits,callableWorkspaceLimits,restoreCallableDescriptor} from './rolldown-callable-protocol'
import type {WorkspaceSnapshot} from '../sandbox/files'
export interface NativeCallableConfiguration {snapshot:WorkspaceSnapshot;maxBytes:number;maxFiles:number;callback(handle:number,method:string,args:unknown[]):Promise<unknown>;bundlerCallback?(id:number,args:unknown[],scope:number,sync:boolean):Promise<unknown>}
export interface NativeCallableHandle {handle:number;hooks:{name:string;order:unknown}[]}
export interface NativeParserOptions {lang?:'js'|'jsx'|'ts'|'tsx';sourceType?:'script'|'module'|'commonjs'|'unambiguous';preserveParens?:boolean}
export interface NativeParserResult {program:string;module:unknown;comments:unknown[];errors:unknown[]}
export interface NativeParserResources {created:number;peak:number;active:number;sharedInitialBytes:number;sharedMaximumBytes:number}
export interface NativeParserConfiguration {
  createWorker():Worker
  wasmURL:string
  pthreadURL:string
  policy:RolldownParserPolicy
  profile?:RolldownCompilerProfile
  resolver?:NativeCallableConfiguration
}
export function nativeParserAssetURL(value:string,origin:string):string{
  const url=new URL(value)
  if(!['http:','https:'].includes(url.protocol)||url.origin!==origin||url.username||url.password||url.hash)throw Error('Native parser assets must be same-origin HTTP URLs')
  return url.href
}
/** Dedicated trusted parser, not an evaluator for workspace JavaScript. */
export class NativeRolldownParser {
  #worker:Worker
  #closed=false
  #sequence=0
  #queue:Promise<unknown>=Promise.resolve()
  #pending=new Map<number,{resolve(value:any):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>()
  #callbacks=new Set<SharedArrayBuffer>()
  #bundlerScopes=new Set<number>()
  #bundlerBuffers=new Set<SharedArrayBuffer>()
  #resolver?:NativeCallableConfiguration
  #policy:Readonly<RolldownParserPolicy>
  #ready:Promise<void>
  #closing:Promise<NativeParserResources>|undefined
  #closedReply:((resources:NativeParserResources)=>void)|undefined
  #closeFailure:((error:Error)=>void)|undefined
  #abortTimer:ReturnType<typeof setTimeout>|undefined
  #cleanup:'live'|'pending'|'acknowledged'|'unconfirmed'='live'
  #cleanupResources:NativeParserResources|undefined
  #syncBuffer:SharedArrayBuffer|undefined
  get cleanupStatus(){return this.#cleanup}
  get cleanupResources(){return this.#cleanupResources?{...this.#cleanupResources}:undefined}
  abort(reason:Error=Error('Native compiler operation cancelled')){this.#stop(reason)}
  private constructor(options:NativeParserConfiguration){
    this.#policy=rolldownParserPolicy(options.policy)!
    this.#resolver=options.resolver
    if(options.resolver)callableWorkspaceLimits(options.resolver.maxBytes,options.resolver.maxFiles)
    if(!this.#policy)throw Error('Native parser requires explicit owner policy')
    if(!globalThis.crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw Error('Native parser requires COI and SAB')
    const wasmURL=nativeParserAssetURL(options.wasmURL,globalThis.location.origin)
    const pthreadURL=nativeParserAssetURL(options.pthreadURL,globalThis.location.origin)
    this.#worker=options.createWorker()
    this.#ready=new Promise((resolve,reject)=>{
      const fail=(error:Error)=>{clearTimeout(timer);reject(error);this.#stop(error)}
      const timer=setTimeout(()=>fail(Error('Native parser startup deadline exceeded')),this.#policy.timeoutMs)
      this.#worker.onerror=event=>fail(Error(event.message||'Native parser worker failed'))
      this.#worker.onmessage=({data})=>{
        if(data?.type==='closed'&&this.#closed){
          if(this.#cleanup!=='pending')return
          clearTimeout(this.#abortTimer)
          this.#cleanupResources=data.resources
          this.#cleanup=data.resources?.active===0?'acknowledged':'unconfirmed'
          this.#worker.terminate();return
        }
        if(data?.type==='closed'&&this.#closedReply){this.#closedReply(data.resources);return}
        if(this.#closed)return
        if(data?.type==='bundler-callback'){
          if(!this.#resolver?.bundlerCallback||!Number.isSafeInteger(data.scope)||!Number.isSafeInteger(data.request)||!Number.isSafeInteger(data.callbackId)||!Array.isArray(data.args)||this.#bundlerScopes.size>=callableLimits.maxBundlerCallbacks||data.sync&&(!(data.buffer instanceof SharedArrayBuffer)||data.buffer.byteLength!==this.#policy.maxSourceBytes+16)){fail(Error('Invalid native bundler callback'));return}
          if(!data.sync)this.#bundlerScopes.add(data.scope)
          else this.#bundlerBuffers.add(data.buffer)
          const reply=(value?:unknown,error?:unknown)=>{
            if(data.sync)this.#replyBundler(data.buffer,value,error)
            else if(!this.#closed)this.#worker.postMessage({type:'bundler-callback-reply',request:data.request,value,error:error?String(error):undefined})
          }
          void Promise.resolve().then(()=>this.#resolver!.bundlerCallback!(data.callbackId,data.args,data.scope,data.sync)).then(value=>reply(value),error=>reply(undefined,error)).finally(()=>{this.#bundlerScopes.delete(data.scope);this.#bundlerBuffers.delete(data.buffer)})
          return
        }
        if(data?.type==='callback'){
          if(!this.#resolver||!(data.buffer instanceof SharedArrayBuffer)||data.buffer.byteLength!==callableLimits.maxCallbackBytes+16||this.#callbacks.size||!Number.isSafeInteger(data.handle)||!(callableCallbackNames as readonly string[]).includes(data.method)||!Array.isArray(data.args)){fail(Error('Invalid native callable callback'));return}
          this.#callbacks.add(data.buffer)
          void Promise.resolve().then(()=>this.#resolver!.callback(data.handle,data.method,data.args)).then(value=>this.#reply(data.buffer,value),error=>this.#reply(data.buffer,undefined,error)).finally(()=>this.#callbacks.delete(data.buffer))
          return
        }
        if(data?.type==='ready'){clearTimeout(timer);resolve();return}
        if(data?.type==='error'){fail(Error(String(data.error)));return}
        if(data?.type!=='result'||!Number.isSafeInteger(data.id)){fail(Error('Invalid native parser reply'));return}
        const pending=this.#pending.get(data.id)
        if(!pending){fail(Error('Unknown native parser reply'));return}
        clearTimeout(pending.timer);this.#pending.delete(data.id)
        data.error?pending.reject(Error(String(data.error))):pending.resolve(data.value)
      }
      const resolver=options.resolver?{snapshot:options.resolver.snapshot,maxBytes:options.resolver.maxBytes,maxFiles:options.resolver.maxFiles}:undefined
      const transfers=resolver?Object.values(resolver.snapshot.files).map(bytes=>bytes.buffer).filter((buffer):buffer is ArrayBuffer=>buffer instanceof ArrayBuffer):[]
      try{this.#worker.postMessage({type:'start',wasmURL,pthreadURL,policy:this.#policy,profile:options.profile??'full',resolver},transfers)}catch(error){fail(Error(String(error)))}
    })
  }
  static async open(options:NativeParserConfiguration){const parser=new NativeRolldownParser(options);await parser.#ready;return parser}
  get closed():boolean{return this.#closed}
  #reply(buffer:SharedArrayBuffer,value?:unknown,error?:unknown){
    const header=new Int32Array(buffer,0,4)
    if(Atomics.load(header,0)!==0)return
    let reply=error?{error:String(error)}:value===undefined?{kind:'undefined'}:value===null?{kind:'null'}:typeof value==='string'?{kind:'string',value}:{error:'Unsupported synchronous callback return'}
    let bytes=new TextEncoder().encode(JSON.stringify(reply))
    if(bytes.length>callableLimits.maxCallbackBytes){reply={error:'Callback reply byte ceiling'};bytes=new TextEncoder().encode(JSON.stringify(reply))}
    new Uint8Array(buffer,16,bytes.length).set(bytes);Atomics.store(header,1,bytes.length);Atomics.store(header,0,'error'in reply?2:1);Atomics.notify(header,0)
  }
  #replyBundler(buffer:SharedArrayBuffer,value?:unknown,error?:unknown){
    const header=new Int32Array(buffer,0,4)
    if(Atomics.load(header,0)!==0)return
    let failed=Boolean(error),text:string
    try{text=JSON.stringify(error?{error:String(error)}:{value})}catch{text=JSON.stringify({error:'Unsupported native bundler callback result'});failed=true}
    let bytes=new TextEncoder().encode(text)
    if(bytes.length>this.#policy.maxSourceBytes){bytes=new TextEncoder().encode('{"error":"Native bundler callback byte ceiling"}');failed=true}
    new Uint8Array(buffer,16,bytes.length).set(bytes);Atomics.store(header,1,bytes.length);Atomics.store(header,0,failed?2:1);Atomics.notify(header,0)
  }
  #stop(error:Error){
    if(this.#closed)return
    this.#closed=true
    for(const buffer of this.#callbacks)this.#reply(buffer,undefined,error)
    this.#callbacks.clear()
    for(const buffer of this.#bundlerBuffers)this.#replyBundler(buffer,undefined,error)
    this.#bundlerBuffers.clear();this.#bundlerScopes.clear()
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(error)}
    this.#pending.clear()
    this.#closeFailure?.(error)
    this.#cleanup='pending'
    const unconfirmed=()=>{clearTimeout(this.#abortTimer);this.#cleanup='unconfirmed';this.#worker.terminate()}
    // A worker cannot directly terminate another worker's children. Keep the
    // parent alive long enough to acknowledge its owned pthread termination.
    this.#abortTimer=setTimeout(unconfirmed,this.#policy.timeoutMs)
    try{this.#worker.postMessage({type:'abort'})}catch{unconfirmed()}
  }
  parse(filename:string,source:string,options?:NativeParserOptions,admission?:'callback-origin-validated'):Promise<NativeParserResult>{
    if(this.#closed||this.#closing)return Promise.reject(Error('Native parser is closed'))
    if(typeof filename!=='string'||filename.length>4096||typeof source!=='string'||new TextEncoder().encode(source).byteLength>this.#policy.maxSourceBytes)return Promise.reject(Error('Native parser input exceeds owner policy'))
    // Only the trusted kernel may attest that guest callback ownership was
    // checked. Ordinary overlap can wait in the existing bounded FIFO; work
    // caused by the blocked callback must still be rejected before admission.
    return this.#request({type:'parse',filename,source,options},admission==='callback-origin-validated')
  }
  #request(command:Record<string,unknown>,callbackOriginValidated=false):Promise<any>{
    if(this.#closed||this.#closing)return Promise.reject(Error('Native parser is closed'))
    if(this.#callbacks.size&&!callbackOriginValidated)return Promise.reject(Error('Nested native calls from callbacks are unsupported'))
    if(this.#pending.size>=callableLimits.maxPending)return Promise.reject(Error('Native compiler pending request ceiling'))
    const id=++this.#sequence
    // Queue time counts toward the request deadline, not just native execution.
    const result=new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>this.#stop(Error('Native parser request deadline exceeded')),this.#policy.timeoutMs)
      this.#pending.set(id,{resolve,reject,timer})
    })
    const completion=result.then(()=>{},()=>{})
    const dispatch=()=>{
      const pending=this.#pending.get(id)
      if(!pending)return
      if(this.#closed||this.#closing){
        clearTimeout(pending.timer);this.#pending.delete(id);pending.reject(Error('Native parser is closed'));return
      }
      try{this.#worker.postMessage({...command,id})}catch(error){this.#stop(Error(String(error)))}
      return completion
    }
    if(command.scope!==undefined){
      if(!Number.isSafeInteger(command.scope)||!this.#bundlerScopes.has(command.scope as number)){
        const pending=this.#pending.get(id)!;clearTimeout(pending.timer);this.#pending.delete(id);pending.reject(Error('Expired native bundler callback scope'))
      }else void dispatch()
    }else this.#queue=this.#queue.then(dispatch)
    return result
  }
  createCallable(descriptor:unknown,scope?:number):Promise<NativeCallableHandle>{
    if(!this.#resolver)return Promise.reject(Error('Native callable resolver is disabled'))
    try{restoreCallableDescriptor(descriptor,()=>undefined)}catch(error){return Promise.reject(error)}
    return this.#request({type:'callable',command:'create',descriptor,scope})
  }
  resolveCallable(handle:number,id:string,importer:string,options:unknown,scope?:number){return this.#request({type:'callable',command:'resolve',handle,specifier:id,importer,options,scope})}
  createBundler(){return this.#request({type:'bundler',command:'create'}) as Promise<number>}
  runBundler(handle:number,method:'generate'|'write'|'scan',options:unknown,snapshot?:WorkspaceSnapshot){return this.#request({type:'bundler',command:'run',handle,method,options,snapshot})}
  closeBundler(handle:number){return this.#request({type:'bundler',command:'close',handle})}
  invokeBundlerContext(scope:number,handle:number,method:string,args:unknown[]){return this.#request({type:'bundler',command:'context',scope,handle,method,args})}
  invokeCallable(handle:number,method:'load'|'transform',args:unknown[]){
    if(!['load','transform'].includes(method)||!Array.isArray(args)||new TextEncoder().encode(JSON.stringify(args)).byteLength>this.#policy.maxSourceBytes)return Promise.reject(Error('Unsupported callable hook arguments'))
    return this.#request({type:'callable',command:'invoke',handle,method,args})
  }
  updateCallable(handle:number,path:string,bytes:Uint8Array|undefined,event:'create'|'update'|'delete'='update'){
    if(!this.#resolver||!['create','update','delete'].includes(event)||(event==='delete'?bytes!==undefined:!(bytes instanceof Uint8Array)||bytes.byteLength>this.#resolver.maxBytes))return Promise.reject(Error('Callable workspace update exceeds owner policy'))
    return this.#request({type:'callable',command:'update',handle,path,bytes:bytes?.slice(),event})
  }
  disposeCallable(handle:number){return this.#request({type:'callable',command:'dispose',handle})}
  #sync(command:Record<string,unknown>):any{
    if(this.#closed||this.#closing)throw Error('Native parser is closed')
    const buffer=this.#syncBuffer??=new SharedArrayBuffer(this.#policy.maxSourceBytes+16),header=new Int32Array(buffer,0,4)
    header.fill(0)
    this.#worker.postMessage({type:'sync',...command,buffer})
    if(Atomics.wait(header,0,0,this.#policy.timeoutMs)==='timed-out'){const error=Error('Native compiler synchronous request deadline exceeded');this.#stop(error);throw error}
    const length=Atomics.load(header,1),status=Atomics.load(header,0)
    if(length<0||length>this.#policy.maxSourceBytes)throw Error('Invalid native compiler synchronous reply')
    const reply=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,16,length).slice()))
    if(status!==1)throw Error(String(reply.error??'Native compiler synchronous request failed'))
    return reply.value
  }
  createTsconfigCache(pathToTsconfig?:string){return this.#sync({command:'create-tsconfig-cache',pathToTsconfig}) as number}
  clearTsconfigCache(handle:number){return this.#sync({command:'clear-tsconfig-cache',handle})}
  tsconfigCacheSize(handle:number){return this.#sync({command:'tsconfig-cache-size',handle}) as number}
  transformSync(filename:string,source:string,options:unknown,cache?:number){
    if(typeof filename!=='string'||filename.length>4096||typeof source!=='string'||new TextEncoder().encode(source).byteLength>this.#policy.maxSourceBytes)throw Error('Native transform input exceeds owner policy')
    return this.#sync({command:'transform',filename,source,options,cache})
  }
  parseSync(filename:string,source:string,options?:NativeParserOptions):NativeParserResult{
    if(typeof filename!=='string'||filename.length>4096||typeof source!=='string'||new TextEncoder().encode(source).byteLength>this.#policy.maxSourceBytes)throw Error('Native parser input exceeds owner policy')
    return this.#sync({command:'parse',filename,source,options}) as NativeParserResult
  }
  close():Promise<NativeParserResources>{
    if(this.#closing)return this.#closing
    if(this.#closed)return Promise.reject(Error('Native parser terminated before cleanup acknowledgement'))
    this.#closing=this.#queue.then(()=>new Promise<NativeParserResources>((resolve,reject)=>{
      if(this.#closed){reject(Error('Native parser terminated before cleanup acknowledgement'));return}
      const clear=()=>{clearTimeout(timer);this.#closedReply=undefined;this.#closeFailure=undefined}
      const timer=setTimeout(()=>this.#stop(Error('Native parser close deadline exceeded')),this.#policy.timeoutMs)
      this.#closeFailure=error=>{clear();reject(error)}
      this.#closedReply=resources=>{clear();this.#closed=true;this.#cleanupResources=resources;this.#cleanup=resources?.active===0?'acknowledged':'unconfirmed';this.#worker.terminate();resolve(resources)}
      try{this.#worker.postMessage({type:'close'})}catch(error){this.#stop(Error(String(error)))}
    }))
    return this.#closing
  }
}
