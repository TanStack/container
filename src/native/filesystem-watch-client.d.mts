import {EventEmitter} from 'node:events'

export interface RemoteFSWatcher extends EventEmitter{
  close():void
  ref():this
  unref():this
}
export declare function createNativeFilesystemWatchClient(
  filesystem:Record<string,(...args:any[])=>unknown>,port:MessagePort,
  options?:{
    EventEmitter?:typeof EventEmitter
    createAsyncResource?:(name:string)=>{
      runInAsyncScope(callback:Function,receiver:unknown,...args:any[]):any
      emitDestroy():unknown
    }
    keepAlive?:()=>()=>void
    signal?:AbortSignal
  },
):{
  watch(path:string,options?:string|((event:string,filename:string|Uint8Array|null)=>void)|{
    encoding?:string;persistent?:boolean;recursive?:boolean;signal?:AbortSignal
  },listener?:(event:string,filename:string|Uint8Array|null)=>void):RemoteFSWatcher
  FSWatcher:new()=>RemoteFSWatcher
  inspect():{disposed:boolean;watches:number}
  dispose():void
}
