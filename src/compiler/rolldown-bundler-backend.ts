/** Native objects stay in the compiler worker. This protocol never evaluates
 * guest source or substitutes compiler options. */
import {callableLimits} from './rolldown-callable-protocol'

export interface BundlerBridge {
  asyncCallback(id:number,args:unknown[],scope:number):Promise<unknown>
  syncCallback(id:number,args:unknown[],scope:number):unknown
}
const asyncHooks=new Set(['buildStart','resolveId','resolveDynamicImport','load','transform','moduleParsed','buildEnd','renderStart','renderChunk','augmentChunkHash','renderError','generateBundle','writeBundle','closeBundle','banner','postBanner','footer','postFooter','intro','outro'])
// These binding callbacks return values synchronously, unlike banner/footer.
const syncOptions=new Set(['onLog','external','pluginTimings','deferSyncScanData','invalidateJsSideCache','onDebug','onWarn','resolveSubpathImports','finalizeBareSpecifier','finalizeOtherSpecifiers','assetFileNames','entryFileNames','chunkFileNames','sanitizeFileName','globals','paths','sourcemapFileNames','sourcemapIgnoreList','sourcemapPathTransform'])
export function decodeBundlerReply(value:any,depth=0):any{
  if(depth>32)throw Error('Bundler callback result nesting limit')
  if(!value||typeof value!=='object')return value
  if(value instanceof Uint8Array)return value
  if(Array.isArray(value))return value.map(item=>decodeBundlerReply(item,depth+1))
  if(value.type==='guest-callback'||value.type==='native-context')throw Error('Unsupported callback result capability')
  if(value.type==='undefined'&&Object.keys(value).length===1)return undefined
  if(value.type==='bytes'){
    if(Object.keys(value).sort().join(',')!=='type,value'||!Array.isArray(value.value)||value.value.some((byte:unknown)=>!Number.isInteger(byte)||(byte as number)<0||(byte as number)>255))throw Error('Invalid callback bytes')
    return new Uint8Array(value.value)
  }
  if(value.type==='error')return Object.assign(new Error(),decodeBundlerReply(value.value,depth+1))
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,decodeBundlerReply(item,depth+1)]))
}
export class NativeBundlerBackend {
  #handles=new Map<number,any>()
  #contexts=new Map<number,{scope:number;value:any}>()
  #nextHandle=0
  #nextScope=0
  #nextContext=0
  #scopes=new Set<number>()
  constructor(private binding:any,private bridge:BundlerBridge,private maxBytes:number,private snapshotBindingResult:(result:any)=>unknown,private maxHandles=32){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>callableLimits.maxWorkspaceBytes||!Number.isSafeInteger(maxHandles)||maxHandles<1||maxHandles>callableLimits.maxHandles)throw Error('Invalid native bundler bounds')
  }
  #bounded(value:any){
    const bytes=new TextEncoder().encode(JSON.stringify(value,(_key,item)=>item instanceof Uint8Array?Array.from(item):item)??'').byteLength
    if(bytes>this.maxBytes)throw Error('Native bundler payload exceeds owner policy')
    return value
  }
  get active(){return this.#handles.size}
  hasScope(scope:number){return this.#scopes.has(scope)}
  create(){
    if(this.#handles.size>=this.maxHandles)throw Error('Native bundler handle ceiling')
    const handle=++this.#nextHandle
    this.#handles.set(handle,new this.binding.BindingBundler())
    this.binding.startAsyncRuntime()
    return handle
  }
  #context(value:any,scope:number):unknown{
    if(value===null||typeof value!=='object')return value
    if(Array.isArray(value))return value.map(item=>this.#context(item,scope))
    if(value instanceof Uint8Array)return value
    if(value instanceof Error)return {type:'error',value:this.#context({...value,name:value.name,message:value.message,stack:value.stack},scope)}
    const prototype=Object.getPrototypeOf(value)
    if(prototype===Object.prototype||prototype===null)return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,this.#context(item,scope)]))
    const nativeDataFields:Record<string,string[]>={
      BindingRenderedChunk:['name','isEntry','isDynamicEntry','facadeModuleId','moduleIds','exports','fileName','modules','imports','dynamicImports'],
      BindingRenderedModule:['code','renderedExports'],
    }
    const fields=nativeDataFields[value.constructor?.name]
    if(fields)return Object.fromEntries(fields.map(key=>[key,this.#context(value[key],scope)]))
    if(this.#contexts.size>=callableLimits.maxBundlerCallbacks)throw Error('Native plugin context ceiling')
    const methods=['inner','resolve','load','emitFile','emitChunk','emitPrebuiltChunk','getFileName','getModuleInfo','getModuleIds','addWatchFile','getCombinedSourcemap'].filter(name=>typeof value[name]==='function')
    if(!methods.length)throw Error('Unsupported native plugin callback object')
    const handle=++this.#nextContext;this.#contexts.set(handle,{scope,value})
    return {type:'native-context',handle,scope,methods,...(methods.includes('inner')?{inner:this.#context(value.inner(),scope)}:{})}
  }
  #release(scope:number){this.#scopes.delete(scope);for(const [id,context]of this.#contexts)if(context.scope===scope)this.#contexts.delete(id)}
  #restore(value:any,key='',depth=0):any{
    if(depth>32)throw Error('Native bundler options exceed depth bound')
    if(value===null||value===undefined||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return value
    if(Array.isArray(value))return value.map(item=>this.#restore(item,'',depth+1))
    if(typeof value!=='object')throw Error('Unsupported native bundler option')
    if(value instanceof Uint8Array)return value
    if(value.type==='undefined'&&Object.keys(value).length===1)return undefined
    if(value.type==='bytes'){
      if(Object.keys(value).sort().join(',')!=='type,value'||!Array.isArray(value.value)||value.value.some((byte:unknown)=>!Number.isInteger(byte)||(byte as number)<0||(byte as number)>255))throw Error('Invalid bundler bytes tag')
      return new Uint8Array(value.value)
    }
    if(value.type==='RegExp'){
      if(Object.keys(value).sort().join(',')!=='flags,source,type'||typeof value.source!=='string'||typeof value.flags!=='string')throw Error('Invalid bundler RegExp tag')
      return new RegExp(value.source,value.flags)
    }
    if(value.type==='guest-callback'){
      if(Object.keys(value).sort().join(',')!=='id,type'||!Number.isSafeInteger(value.id)||value.id<1)throw Error('Invalid bundler callback tag')
      if(!asyncHooks.has(key)&&!syncOptions.has(key))throw Error('Unsupported native bundler callback: '+key)
      const invoke=(args:unknown[])=>{
        const scope=++this.#nextScope
        if(this.#scopes.size>=callableLimits.maxBundlerCallbacks)throw Error('Native bundler callback ceiling')
        this.#scopes.add(scope)
        try{return {scope,args:this.#bounded(args.map(arg=>this.#context(arg,scope)))}}catch(error){this.#release(scope);throw error}
      }
      if(asyncHooks.has(key))return async(...args:unknown[])=>{
        const call=invoke(args)
        try{return decodeBundlerReply(this.#bounded(await this.bridge.asyncCallback(value.id,call.args,call.scope)))}finally{this.#release(call.scope)}
      }
      return (...args:unknown[])=>{
        const call=invoke(args)
        try{return decodeBundlerReply(this.#bounded(this.bridge.syncCallback(value.id,call.args,call.scope)))}finally{this.#release(call.scope)}
      }
    }
    return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,this.#restore(item,name,depth+1)]))
  }
  invokeContext(scope:number,handle:number,method:string,args:unknown[]){
    const record=this.#contexts.get(handle)
    if(!this.#scopes.has(scope)||record?.scope!==scope)throw Error('Expired native plugin context')
    if(!['inner','resolve','load','emitFile','emitChunk','emitPrebuiltChunk','getFileName','getModuleInfo','getModuleIds','addWatchFile','getCombinedSourcemap'].includes(method)||typeof record.value[method]!=='function'||!Array.isArray(args))throw Error('Unsupported native plugin context method')
    this.#bounded(args)
    const value=record.value[method](...decodeBundlerReply(args))
    return value&&typeof value.then==='function'?value.then((result:unknown)=>this.#bounded(this.#context(result,scope))):this.#bounded(this.#context(value,scope))
  }
  async run(handle:number,method:'generate'|'write'|'scan',options:unknown){
    const bundler=this.#handles.get(handle)
    if(!bundler)throw Error('Unknown native bundler handle')
    if(!['generate','write','scan'].includes(method))throw Error('Unsupported native bundler operation')
    this.#bounded(options)
    const result=await bundler[method](this.#restore(options))
    return this.#bounded({result:method==='scan'&&result===undefined?undefined:this.snapshotBindingResult(result),watchFiles:bundler.getWatchFiles(),closed:bundler.closed})
  }
  async close(handle:number){
    const bundler=this.#handles.get(handle)
    if(!bundler)throw Error('Unknown native bundler handle')
    try{await bundler.close()}finally{this.#handles.delete(handle);await this.binding.shutdownAsyncRuntime()}
  }
  async closeAll(){for(const handle of [...this.#handles.keys()])await this.close(handle);for(const scope of [...this.#scopes])this.#release(scope)}
}
