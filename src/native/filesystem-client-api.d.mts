import type {fs as memoryFilesystem} from 'memfs'
import type {Buffer} from 'buffer'
import type {FileHandle} from 'node:fs/promises'
import type {RemoteFSWatcher} from './filesystem-watch-client.mjs'
import type {NativeFileReadStream,NativeFileWriteStream} from './filesystem-stream-api.mjs'

type SyncName={
  [Name in keyof typeof memoryFilesystem]:Name extends `${string}Sync`?Name:never
}[keyof typeof memoryFilesystem]
type SyncFilesystem=Omit<Pick<typeof memoryFilesystem,Exclude<SyncName,'opendirSync'>|'constants'|'Stats'|'Dirent'>,'globSync'> & {
  globSync:typeof import('node:fs').globSync
  opendirSync:typeof import('node:fs').opendirSync
  Dir:abstract new(...args:never[])=>import('node:fs').Dir
}
type CallbackName='fstat'|'stat'|'lstat'|'statfs'|'readdir'|'readFile'|'readlink'|'realpath'|'mkdir'|'mkdtemp'|'open'|'glob'|
  'access'|'appendFile'|'chmod'|'chown'|'close'|'copyFile'|'cp'|'fchmod'|'fchown'|'fdatasync'|'fsync'|
  'ftruncate'|'futimes'|'lchmod'|'lchown'|'link'|'rename'|'rmdir'|'rm'|'symlink'|'truncate'|'unlink'|'utimes'|'lutimes'|'writeFile'|
  'exists'|'read'|'write'|'readv'|'writev'
type SupportedHandle=Pick<FileHandle,'fd'|'close'|'read'|'write'|'readv'|'writev'|'readFile'|'writeFile'|'appendFile'|
  'stat'|'chmod'|'chown'|'truncate'|'utimes'|'sync'|'datasync'|typeof Symbol.asyncDispose> & {
  on(event:string,callback:(...args:any[])=>void):SupportedHandle
  removeListener(event:string,callback:(...args:any[])=>void):SupportedHandle
}
type PromiseName='fstat'|'stat'|'lstat'|'statfs'|'readdir'|'readFile'|'readlink'|'realpath'|'mkdir'|'mkdtemp'|
  'access'|'appendFile'|'chmod'|'chown'|'copyFile'|'cp'|'lchmod'|'lchown'|'link'|'rename'|'rmdir'|'rm'|'symlink'|'truncate'|'unlink'|'utimes'|'lutimes'|'writeFile'
type SupportedPromises=Pick<typeof memoryFilesystem.promises,Exclude<Extract<PromiseName,keyof typeof memoryFilesystem.promises>,'readFile'|'writeFile'|'appendFile'>> & {
  constants:typeof memoryFilesystem.constants
  open(path:unknown,flags?:string|number,mode?:number):Promise<SupportedHandle>
  readFile(path:unknown,options?:unknown):Promise<Buffer|string>
  writeFile(path:unknown,data:unknown,options?:unknown):Promise<void>
  appendFile(path:unknown,data:unknown,options?:unknown):Promise<void>
  glob(pattern:string|string[],options?:unknown):AsyncIterableIterator<string|InstanceType<typeof memoryFilesystem.Dirent>>
  opendir:typeof import('node:fs/promises').opendir
}
type Watch=(path:unknown,options?:string|((event:string,filename:string|Uint8Array|null)=>void)|{
  encoding?:string;persistent?:boolean;recursive?:boolean;signal?:AbortSignal
},listener?:(event:string,filename:string|Uint8Array|null)=>void)=>RemoteFSWatcher

export declare function createNativeFilesystemClientApi(
  filesystem:Record<string,(...args:any[])=>unknown>,constructors:typeof memoryFilesystem,port:MessagePort,
  options?:{
    cwd?:()=>string
    createAsyncResource?:(name:string)=>{
      runInAsyncScope(callback:Function,receiver:unknown,...args:any[]):any
      emitDestroy():unknown
    }
    keepAlive?:()=>()=>void
    signal?:AbortSignal
  },
):{
  vol:SyncFilesystem & {watch:Watch;writeFileWithParentsSync(path:string,contents:Uint8Array,
    options?:{followSymlinks?:boolean;mode?:number}):void}
  fs:SyncFilesystem & Pick<typeof memoryFilesystem,Extract<CallbackName,keyof typeof memoryFilesystem>> & {
    promises:SupportedPromises
    watch:Watch
    createReadStream(path:unknown,options?:unknown):NativeFileReadStream
    createWriteStream(path:unknown,options?:unknown):NativeFileWriteStream
    ReadStream:new(path:unknown,options?:unknown)=>NativeFileReadStream
    WriteStream:new(path:unknown,options?:unknown)=>NativeFileWriteStream
    FSWatcher:new()=>RemoteFSWatcher
    opendir:typeof import('node:fs').opendir
  }
  FileHandle:new(fd:number)=>SupportedHandle
  inspect():{disposed:boolean;watches:number}
  inspectDirectories():{directories:number}
  changedPaths(scope:string):string[]
  dispose():void
}
