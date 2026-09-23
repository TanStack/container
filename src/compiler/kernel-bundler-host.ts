import {WorkspaceFiles} from '../sandbox/files'
import type {NativeRolldownParser} from './rolldown-parser'
import {decodeBundlerReply} from './rolldown-bundler-backend'
import {callableLimits} from './rolldown-callable-protocol'

let nextCallback=0
const routes=new Map<number,(args:unknown[],scope:number,sync:boolean)=>Promise<unknown>>()
export function dispatchKernelBundlerCallback(id:number,args:unknown[],scope:number,sync:boolean){
  const route=routes.get(id)
  return route?route(args,scope,sync):Promise.reject(Error('Native bundler callback owner is unavailable'))
}
/** Validate every output against its pre-build bytes before committing any file. */
export function applyKernelBundlerFiles(workspace:WorkspaceFiles,outputs:Record<string,Uint8Array>,previous:Record<string,Uint8Array|null>){
  const paths=Object.keys(outputs)
  if(paths.length===0){if(Object.keys(previous).length)throw Error('Invalid native bundler output history');return}
  if(paths.length>workspace.maxFiles||Object.keys(previous).length!==paths.length)throw Error('Native bundler output file limit')
  const revision=workspace.revision,snapshot=workspace.snapshot()
  if(snapshot.version!==5)throw Error('Expected current workspace snapshot')
  for(const path of paths){
    if(!path.startsWith('/')||path==='/'||path.split('/').slice(1).some(part=>!part||part==='.'||part==='..')||!(outputs[path] instanceof Uint8Array)||!Object.hasOwn(previous,path))throw Error('Invalid native bundler output')
    const components=path.split('/')
    for(let n=2;n<=components.length;n++)if(Object.hasOwn(snapshot.symlinks,components.slice(0,n).join('/')))throw Error('ECONFLICT: native bundler output path is a symlink')
    const expected=previous[path],current=snapshot.files[path]
    if(expected===null?current!==undefined||snapshot.directories.includes(path):!(expected instanceof Uint8Array)||!current||current.length!==expected.length||current.some((byte,index)=>byte!==expected[index]))throw Error('ECONFLICT: native bundler output changed during build: '+path)
  }
  const staged=new WorkspaceFiles({},workspace.maxBytes,workspace.maxFiles)
  try{
    staged.replace(snapshot)
    for(const path of paths)staged.writeFileSync(path,outputs[path])
    workspace.replace(staged.snapshot(),revision)
  }finally{staged.close()}
}
type Callback={id:number;scope:number;sync:boolean;method:string;started:number;resolve(value:unknown):void;reject(error:unknown):void}
type Operation={id:number;handle:number;method:string;stage:string;started:number;trace:string;error?:string;events:unknown[];waiter?:{resolve(value:unknown):void;reject(error:Error):void};callbacks:Map<number,Callback>;cancelled:boolean;settled?:Promise<void>}
type Registration={remote?:number;callbacks:Map<number,number>;active?:Operation;closed:boolean}
export function createKernelBundlerHost(options:{files:WorkspaceFiles;signal:AbortSignal;maxBytes:number;getParser():Promise<NativeRolldownParser>;enqueue(work:()=>Promise<void>):Promise<void>}){
  const registrations=new Map<number,Registration>(),operations=new Map<number,Operation>()
  const work=new Set<Promise<void>>()
  let parserInstance:NativeRolldownParser|undefined
  let nextHandle=0,nextOperation=0,nextEvent=0,closed=false,pendingBytes=0
  let completed=0,failed=0,callbacksCompleted=0,callbacksFailed=0
  const methods=Object.fromEntries(['generate','write','scan','close'].map(method=>[method,{admitted:0,completed:0,failed:0}]))
  const recent:unknown[]=[],contexts=new Map<number,{scope:number;method:string;started:number}>()
  let nextContext=0
  const row=(operation:Operation)=>({id:operation.id,handle:operation.handle,method:operation.method,stage:operation.stage,ageMs:Math.max(0,performance.now()-operation.started),waitingGuest:!!operation.waiter,queuedEvents:operation.events.length,cancelled:operation.cancelled,trace:operation.trace,error:operation.error,callbackCount:operation.callbacks.size,callbacks:[...operation.callbacks.values()].slice(0,16).map(callback=>({id:callback.id,scope:callback.scope,sync:callback.sync,method:callback.method,ageMs:Math.max(0,performance.now()-callback.started)}))})
  const fail=()=>Error('Native bundler process cancelled')
  const emit=(operation:Operation,event:unknown)=>{if(operation.cancelled)return;if(operation.waiter){const waiter=operation.waiter;operation.waiter=undefined;waiter.resolve(event)}else{if(operation.events.length>=64)throw Error('Native bundler event limit');operation.events.push(event)}}
  const cancel=(operation:Operation)=>{operation.cancelled=true;for(const callback of operation.callbacks.values())callback.reject(fail());operation.callbacks.clear();operation.waiter?.reject(fail());operation.waiter=undefined;operation.events=[]}
  const check=()=>{if(closed||options.signal.aborted)throw fail()}
  function register(registration:Registration,id:number,method:string){
    const found=registration.callbacks.get(id);if(found!==undefined)return found
    if(!Number.isSafeInteger(id)||id<1||registration.callbacks.size>=1024||nextCallback>=Number.MAX_SAFE_INTEGER)throw Error('Native bundler callback registration limit')
    const globalId=++nextCallback
    registration.callbacks.set(id,globalId)
    routes.set(globalId,(args,scope,sync)=>new Promise((resolve,reject)=>{
      const operation=registration.active
      if(closed||options.signal.aborted||!operation||operation.cancelled){reject(fail());return}
      if(operation.callbacks.size>=callableLimits.maxBundlerCallbacks){reject(Error('Native bundler callback limit'));return}
      const eventId=++nextEvent
      operation.callbacks.set(eventId,{id:eventId,scope,sync,method:method.slice(0,256),started:performance.now(),resolve,reject})
      try{emit(operation,{type:'callback',id:eventId,callbackId:id,args,scope,sync})}catch(error){operation.callbacks.delete(eventId);reject(error)}
    }))
    return globalId
  }
  function remap(value:any,registration:Registration,depth=0,path=''):any{
    if(depth>32)throw Error('Native bundler input depth limit')
    if(!value||typeof value!=='object')return value
    if(Array.isArray(value))return value.map((item,index)=>remap(item,registration,depth+1,path+'.'+index))
    if(value.type==='guest-callback')return {...value,id:register(registration,value.id,path)}
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remap(item,registration,depth+1,path?path+'.'+key:key)]))
  }
  const release=(registration:Registration)=>{for(const id of registration.callbacks.values())routes.delete(id);registration.callbacks.clear();registration.closed=true}
  return {
    get pending(){return work.size},
    snapshot(){return {handles:registrations.size,nativeHandles:[...registrations.values()].filter(item=>item.remote!==undefined).length,pending:work.size,queued:[...operations.values()].filter(item=>item.stage==='queued').length,pendingBytes,completed,failed,methods:Object.fromEntries(Object.entries(methods).map(([key,value])=>[key,{...value}])),callbacksCompleted,callbacksFailed,operationCount:operations.size,operations:[...operations.values()].slice(0,16).map(row),contextCount:contexts.size,contexts:[...contexts.values()].slice(0,16).map(item=>({...item,ageMs:Math.max(0,performance.now()-item.started)})),recent:[...recent]}},
    create(){check();if(registrations.size>=32)throw Error('Native bundler handle limit');const id=++nextHandle;registrations.set(id,{callbacks:new Map(),closed:false});return id},
    start(handle:number,method:string,input:unknown,trace=''){
      check()
      const registration=registrations.get(handle)
      if(!registration||registration.closed||!['generate','write','scan','close'].includes(method)||operations.size>=64)throw Error('Unsupported native bundler operation')
      const bytes=new TextEncoder().encode(JSON.stringify(input)??'').byteLength
      if(bytes>options.maxBytes-pendingBytes)throw Error('Native bundler aggregate input byte limit')
      const encoded=remap(input,registration),id=++nextOperation,operation:Operation={id,handle,method,stage:'queued',started:performance.now(),trace:String(trace).slice(0,2000),events:[],callbacks:new Map(),cancelled:false}
      pendingBytes+=bytes;operations.set(id,operation)
      methods[method].admitted++
      operation.settled=options.enqueue(async()=>{
        try{
          check();if(operation.cancelled)throw fail()
          operation.stage='opening-session'
          const parser=parserInstance=await options.getParser()
          if(registration.remote===undefined){operation.stage='creating-handle';registration.remote=await parser.createBundler()}
          registration.active=operation
          if(method==='close'){
            operation.stage='closing-native'
            await parser.closeBundler(registration.remote);registration.remote=undefined;release(registration);registrations.delete(handle)
            emit(operation,{type:'result',value:undefined})
          }else{
            operation.stage='running-native'
            const result=await parser.runBundler(registration.remote,method as 'generate'|'write'|'scan',encoded,options.files.snapshot())
            check();if(operation.cancelled)throw fail()
            if(method==='write'){operation.stage='applying-writes';applyKernelBundlerFiles(options.files,result.files,result.previousFiles)}
            emit(operation,{type:'result',value:{result:result.result,watchFiles:result.watchFiles,closed:result.closed}})
          }
          operation.stage='result-ready';completed++;methods[method].completed++
        }catch(error){operation.stage='failed';operation.error=String(error).slice(0,1000);failed++;methods[method].failed++;emit(operation,{type:'error',error:{type:'error',value:{message:String(error)}}})}
        finally{registration.active=undefined;pendingBytes-=bytes;recent.push(row(operation));if(recent.length>8)recent.shift()}
      })
      work.add(operation.settled)
      void operation.settled.finally(()=>work.delete(operation.settled!)).catch(()=>{})
      return id
    },
    next(id:number){const operation=operations.get(id);if(!operation||operation.cancelled)return Promise.reject(fail());if(operation.events.length)return Promise.resolve(operation.events.shift());if(operation.waiter)return Promise.reject(Error('Native bundler operation already waiting'));return new Promise((resolve,reject)=>{operation.waiter={resolve,reject}})},
    reply(id:number,eventId:number,reply:any){
      const operation=operations.get(id),callback=operation?.callbacks.get(eventId)
      if(!callback)throw Error('Unknown native bundler callback reply')
      if(new TextEncoder().encode(JSON.stringify(reply)).byteLength>options.maxBytes)throw Error('Native bundler callback reply byte limit')
      operation!.callbacks.delete(eventId)
      if(reply?.type==='value'){callbacksCompleted++;callback.resolve(reply.value)}
      else if(reply?.type==='error'){callbacksFailed++;callback.reject(decodeBundlerReply(reply.error))}
      else{callbacksFailed++;callback.reject(Error('Invalid native bundler callback reply'))}
    },
    hasScope(scope:number){return [...operations.values()].some(operation=>!operation.cancelled&&[...operation.callbacks.values()].some(callback=>callback.scope===scope&&!callback.sync))},
    context(scope:number,handle:number,method:string,args:unknown[]){
      check()
      if(!this.hasScope(scope)||!['resolve','load'].includes(method)||!Array.isArray(args)||new TextEncoder().encode(JSON.stringify(args)).byteLength>options.maxBytes)throw Error('Invalid native bundler callback scope')
      const id=++nextContext
      contexts.set(id,{scope,method,started:performance.now()})
      return options.getParser().then(parser=>parser.invokeBundlerContext(scope,handle,method,args)).finally(()=>contexts.delete(id))
    },
    cancel(id:number){const operation=operations.get(id);if(operation)cancel(operation)},
    finish(id:number){const operation=operations.get(id);if(operation){cancel(operation);operations.delete(id)}},
    async close(){
      closed=true;for(const operation of operations.values())cancel(operation)
      await Promise.all(work)
      let failure:unknown
      for(const registration of registrations.values()){
        try{if(registration.remote!==undefined&&parserInstance&&!parserInstance.closed)await parserInstance.closeBundler(registration.remote)}catch(error){failure??=error}
        finally{release(registration)}
      }
      registrations.clear();operations.clear();if(failure)throw failure
    },
  }
}
export type KernelBundlerSnapshot=ReturnType<ReturnType<typeof createKernelBundlerHost>['snapshot']>
