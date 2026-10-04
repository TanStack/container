import type {fs} from 'memfs'
import type {Readable,Writable} from 'node:stream'

export interface NativeFileReadStream extends Readable {
  fd:number|null
  path?:string|Buffer
  bytesRead:number
  pending:boolean
  autoClose:boolean
  close(callback?:(error?:Error|null)=>void):void
  open():void
}
export interface NativeFileWriteStream extends Writable {
  fd:number|null
  path?:string|Buffer
  bytesWritten:number
  pending:boolean
  autoClose:boolean
  close(callback?:()=>void):void
  open():void
  destroySoon(...args:Parameters<Writable['end']>):this
}
export interface NativeFilesystemStreamApi {
  ReadStream:new(path:unknown,options?:unknown)=>NativeFileReadStream
  WriteStream:new(path:unknown,options?:unknown)=>NativeFileWriteStream
  createReadStream(path:unknown,options?:unknown):NativeFileReadStream
  createWriteStream(path:unknown,options?:unknown):NativeFileWriteStream
}
export declare function createNativeFilesystemStreamApi(
  callbacks:{[Name in 'open'|'read'|'close']:(...args:Parameters<typeof fs[Name]>)=>ReturnType<typeof fs[Name]>} &
    Partial<{[Name in 'write'|'writev'|'fsync']:(...args:Parameters<typeof fs[Name]>)=>ReturnType<typeof fs[Name]>}>,
  options?:{keepAlive?:()=>()=>void},
):NativeFilesystemStreamApi
