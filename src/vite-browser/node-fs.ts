import {createNativeFilesystemBackend} from '../native/filesystem-backend.mjs'
import {createNativeFilesystemStreamApi} from '../native/filesystem-stream-api.mjs'
import { Buffer } from 'buffer'
import browserPath from 'path-browserify'
import type { WorkspaceSnapshot } from '../sandbox/files'
import type {NativeSyncFileClient} from '../native/sync-file-bridge'
import {keepNodeCommandAlive,trackNodeCommandPromise} from './node-timers'
import {EventEmitter} from './node-events'
import {getNativeFilesystemProvider} from '../native/filesystem-provider.mjs'
import type {fs as memoryFilesystem} from 'memfs'
const remoteProvider=getNativeFilesystemProvider()
const localProvider=remoteProvider?undefined:createNativeFilesystemBackend()
// Only standalone controls without a worker bootstrap create a local backend.
// Native runtime workers must install their provider before importing this file.
const {fs,vol}=remoteProvider??localProvider!
export {vol}

// Defer callback lookup until the module has finished initializing.
const fileStreams=createNativeFilesystemStreamApi({
  open:(...args)=>open(...args),read:(...args)=>read(...args),
  write:(...args)=>write(...args),close:(...args)=>close(...args),fsync:(...args)=>fsync(...args),
},{keepAlive:keepNodeCommandAlive})
export class ReadStream extends fileStreams.ReadStream{
  constructor(path:unknown,options?:unknown){super(streamPath(path,options),options)}
}
export class WriteStream extends fileStreams.WriteStream{
  constructor(path:unknown,options?:unknown){super(streamPath(path,options),options)}
}
function streamPath(path:unknown,options:unknown){
  const fd=options&&typeof options==='object'?(options as {fd?:unknown}).fd:undefined
  return fd==null?filePath(path):path
}

let liveFileClient:NativeSyncFileClient|undefined
const liveDescriptors=new Map<number,number>()
let nextLiveDescriptor=1000000
/** Installed only in an isolated native project worker. */
export function setNativeSyncFileClient(client:NativeSyncFileClient|undefined){
  for(const watcher of [...liveWatchers])watcher.close()
  for(const watcher of liveStatWatchers.values())watcher.stop()
  liveStatWatchers.clear()
  liveFileClient=client;liveDescriptors.clear()
}
export function getNativeSyncFileClient(){return liveFileClient}
function liveClient():NativeSyncFileClient{
  const client=liveFileClient
  if(!client)throw Error('Native workspace filesystem is unavailable')
  return client
}

function bind<T extends (...args: never[]) => unknown>(method: T): T {
  return method.bind(fs) as T
}

function filePath(path:unknown):unknown{
  if(typeof path==='string'&&liveFileClient&&!path.startsWith('/')){
    const cwd=(globalThis as typeof globalThis & {process?:{cwd?:()=>string}}).process?.cwd?.()
    if(!isContainerPath(cwd))throw Error('Native workspace cwd is unavailable')
    const resolved=browserPath.resolve(cwd,path)
    if(!isContainerPath(resolved))throw Object.assign(Error('Cannot leave the container filesystem'),{code:'ERR_OUTSIDE_CONTAINER_PATH'})
    return resolved
  }
  if(!(path instanceof URL))return path
  if(path.protocol!=='file:'||path.hostname&&path.hostname!=='localhost')
    throw new TypeError('Only local file URLs are valid filesystem paths')
  if(/%2f|%5c/i.test(path.pathname))throw new TypeError('File URL contains an encoded path separator')
  return decodeURIComponent(path.pathname)
}
function isContainerPath(path:unknown):path is string{
  return typeof path==='string'&&(path==='/app'||path.startsWith('/app/')||path==='/tmp'||path.startsWith('/tmp/'))
}
function isLivePath(path:unknown):path is string{
  return Boolean(liveFileClient&&isContainerPath(path))
}
function callbackVoid(callback:unknown,operation:()=>void){
  if(typeof callback!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{try{operation()}catch(error){callback(error);return}callback(null)})
}
function fileTime(value:unknown):number{
  const seconds=value instanceof Date?value.getTime()/1000:
    typeof value==='string'&&value.trim()?Number(value):value
  if(typeof seconds!=='number'||!Number.isFinite(seconds))throw TypeError('Invalid file time')
  return seconds
}

export function accessSync(path:unknown,mode=fs.constants.F_OK):void{
  const target=filePath(path)
  if(!isLivePath(target)){fs.accessSync(target as never,mode);return}
  liveFileClient!.call('access',[target,mode])
}
export const access=((path:unknown,mode:unknown,callback?:Function)=>
  callbackVoid(typeof mode==='function'?mode:callback,()=>accessSync(path,typeof mode==='function'||mode===undefined?fs.constants.F_OK:mode as number))) as typeof fs.access
export const appendFile = ((path:unknown,data:unknown,options:unknown,callback?:Function)=>{
  const done=typeof options==='function'?options as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{
    try{appendFileSync(path,data,typeof options==='function'?undefined:options)}catch(error){done(error);return}
    done(null)
  })
}) as typeof fs.appendFile
export function appendFileSync(path:unknown,data:unknown,options?:unknown):void{
  const settings=typeof options==='string'?{encoding:options}:typeof options==='object'&&options?options as {encoding?:string;flag?:string;mode?:number}:{}
  writeFileSync(path,data,{...settings,flag:settings.flag??'a'})
}
export function chmodSync(path:unknown,mode:number):void{
  const target=filePath(path)
  if(!isLivePath(target)){fs.chmodSync(target as never,mode);return}
  liveFileClient!.call('chmod',[target,mode])
}
export const chmod = ((path:unknown,mode:number,callback:Function)=>callbackVoid(callback,()=>chmodSync(path,mode))) as typeof fs.chmod
export function fchmodSync(fd:number,mode:number):void{
  const remote=liveDescriptors.get(fd)
  if(remote===undefined){fs.fchmodSync(fd,mode);return}
  liveFileClient!.call('fchmod',[remote,mode])
}
export const fchmod = ((fd:number,mode:number,callback:Function)=>callbackVoid(callback,()=>fchmodSync(fd,mode))) as typeof fs.fchmod
export function closeSync(fd:number):void{
  const remote=liveDescriptors.get(fd)
  if(remote===undefined){fs.closeSync(fd);return}
  liveDescriptors.delete(fd)
  liveFileClient!.call('close',[remote])
}
export const close = ((fd:number,callback:Function)=>{
  if(typeof callback!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{try{closeSync(fd)}catch(error){callback(error);return}callback(null)})
}) as typeof fs.close
export function fsyncSync(fd:number):void{
  const remote=liveDescriptors.get(fd)
  if(remote===undefined){fs.fsyncSync(fd);return}
  liveFileClient!.call('fsync',[remote])
}
export function fdatasyncSync(fd:number):void{
  const remote=liveDescriptors.get(fd)
  if(remote===undefined){fs.fdatasyncSync(fd);return}
  liveFileClient!.call('fdatasync',[remote])
}
export const fsync=((fd:number,callback:Function)=>callbackVoid(callback,()=>fsyncSync(fd))) as typeof fs.fsync
export const fdatasync=((fd:number,callback:Function)=>callbackVoid(callback,()=>fdatasyncSync(fd))) as typeof fs.fdatasync
export const copyFile = ((source:unknown,target:unknown,flags:unknown,callback?:Function)=>{
  const done=typeof flags==='function'?flags as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{
    try{copyFileSync(source,target,typeof flags==='function'?undefined:flags)}catch(error){done(error);return}
    done(null)
  })
}) as typeof fs.copyFile
export function copyFileSync(source:unknown,target:unknown,flags?:unknown):void{
  const from=filePath(source),to=filePath(target)
  if(!isLivePath(from)||!isLivePath(to)){
    Reflect.apply(fs.copyFileSync,fs,[from,to,flags]);return
  }
  liveFileClient!.call('copyFile',[from,to,flags??0])
}
export function cpSync(source:unknown,target:unknown,options?:unknown):void{
  const from=filePath(source),to=filePath(target)
  if(!isLivePath(from)||!isLivePath(to)){
    Reflect.apply(fs.cpSync,fs,[from,to,options]);return
  }
  liveFileClient!.call('cp',[from,to,options??{}])
}
export const cp = ((source:unknown,target:unknown,options:unknown,callback?:Function)=>{
  const done=typeof options==='function'?options as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{
    try{cpSync(source,target,typeof options==='function'?undefined:options)}catch(error){done(error);return}
    done(null)
  })
}) as typeof fs.cp
export const createReadStream = ((path:unknown,options?:unknown)=>{
  return new ReadStream(path,options)
})
export const createWriteStream = ((path:unknown,options?:unknown)=>{
  return new WriteStream(path,options)
})
export const exists = bind(fs.exists)
export function existsSync(path:unknown):boolean{
  const target=filePath(path)
  if(!isLivePath(target))
    return fs.existsSync(target as never)
  try{liveClient().call('stat',[target]);return true}
  catch(error){if((error as {code?:string}).code==='ENOENT')return false;throw error}
}
export function fstatSync(fd:number,options?:{bigint?:boolean}){
  const remote=liveDescriptors.get(fd)
  return remote===undefined?fs.fstatSync(fd,options as never):
    toNodeStat(liveFileClient!.call('fstat',[remote]) as LiveStat,options?.bigint===true)
}
export const fstat = ((fd:number,options:unknown,callback?:Function)=>{
  const done=typeof options==='function'?options as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{let value:unknown
    try{value=fstatSync(fd,typeof options==='function'?undefined:options as {bigint?:boolean}|undefined)}
    catch(error){done(error);return}done(null,value)})
}) as typeof fs.fstat
export function futimesSync(fd:number,atime:unknown,mtime:unknown):void{
  const remote=liveDescriptors.get(fd)
  if(remote===undefined){fs.futimesSync(fd,atime as never,mtime as never);return}
  liveFileClient!.call('futimes',[remote,fileTime(atime),fileTime(mtime)])
}
export const futimes = ((fd:number,atime:unknown,mtime:unknown,callback:Function)=>
  callbackVoid(callback,()=>futimesSync(fd,atime,mtime))) as typeof fs.futimes
export function ftruncateSync(fd:number,length=0):void{
  const remote=liveDescriptors.get(fd)
  if(remote===undefined){fs.ftruncateSync(fd,length);return}
  liveFileClient!.call('ftruncate',[remote,length])
}
export const ftruncate = ((fd:number,length:unknown,callback?:Function)=>{
  const done=typeof length==='function'?length:callback
  callbackVoid(done,()=>ftruncateSync(fd,typeof length==='number'?length:0))
}) as typeof fs.ftruncate
export const lstat = pathReadCallback((path,options)=>liveStat(path,false,options as NativeStatOptions|undefined)) as typeof fs.lstat
type LiveStat={size:number;mode:number;dev:number;ino:number;nlink:number;uid:number;gid:number;rdev:number;
  blksize:number;blocks:number;atimeMs:number;mtimeMs:number;ctimeMs:number;birthtimeMs:number;
  kind:'file'|'directory'|'symlink'}
function toNodeStat(value:Omit<LiveStat,'kind'>&Partial<Pick<LiveStat,'kind'>>,bigint=false){
  const numbers=bigint?Object.fromEntries(Object.entries(value).filter(([,entry])=>typeof entry==='number')
    .map(([key,entry])=>[key,BigInt(Math.trunc(entry as number))])):{}
  const nanos=bigint?Object.fromEntries(['atime','mtime','ctime','birthtime'].map(name=>
    [name+'Ns',BigInt(Math.trunc(value[(name+'Ms') as keyof LiveStat] as number))*1000000n])):{}
  // WASI's file proxy preserves constructors, not function-valued properties.
  // Use the same Stats class as the local backend so live results keep methods.
  return Object.assign(new fs.Stats(),value,numbers,nanos,{atime:new Date(value.atimeMs),mtime:new Date(value.mtimeMs),
    ctime:new Date(value.ctimeMs),birthtime:new Date(value.birthtimeMs)})
}
type NativeStatOptions={throwIfNoEntry?:boolean;bigint?:boolean}
function liveStat(path:unknown,follow:boolean):NonNullable<ReturnType<typeof fs.statSync>>
function liveStat(path:unknown,follow:boolean,options:{throwIfNoEntry:false;bigint?:boolean}):ReturnType<typeof fs.statSync>
function liveStat(path:unknown,follow:boolean,options:NativeStatOptions|undefined):ReturnType<typeof fs.statSync>
function liveStat(path:unknown,follow:boolean,options?:NativeStatOptions){
  const target=filePath(path)
  try{
    if(!isLivePath(target))
      return follow?fs.statSync(target as never,options as never):fs.lstatSync(target as never,options as never)
    return toNodeStat(liveClient().call(follow?'stat':'lstat',[target]) as LiveStat,options?.bigint===true)
  }catch(error){
    if(options?.throwIfNoEntry===false&&(error as {code?:string}).code==='ENOENT')return undefined
    throw error
  }
}
export function lstatSync(path:unknown):NonNullable<ReturnType<typeof fs.lstatSync>>
export function lstatSync(path:unknown,options:NativeStatOptions):ReturnType<typeof liveStat>
export function lstatSync(path:unknown,options?:NativeStatOptions){return liveStat(path,false,options)}
export const mkdir = pathReadCallback(mkdirSync) as typeof fs.mkdir
export function mkdirSync(path:unknown,options?:unknown):unknown{
  const target=filePath(path)
  if(!isLivePath(target)){
    return Reflect.apply(fs.mkdirSync,fs,[target,options])
  }
  const recursive=typeof options==='object'&&options!==null&&(options as {recursive?:boolean}).recursive===true
  const requested=typeof options==='number'||typeof options==='string'?options:
    typeof options==='object'&&options!==null?(options as {mode?:unknown}).mode:undefined
  const mode=requested===undefined?0o777:typeof requested==='string'&&/^[0-7]+$/.test(requested)?parseInt(requested,8):requested
  if(typeof mode!=='number'||!Number.isInteger(mode)||mode<0||mode>0xffffffff)throw TypeError('Invalid directory mode')
  if(typeof options==='object'&&options!==null&&(options as {recursive?:unknown}).recursive!==undefined&&
    typeof (options as {recursive?:unknown}).recursive!=='boolean')throw TypeError('Invalid recursive flag')
  return liveClient().call('mkdir',[target,recursive,mode])
}
export function mkdtempSync(prefix:unknown,options?:unknown):unknown{
  const target=filePath(Buffer.isBuffer(prefix)?prefix.toString():prefix)
  if(typeof target!=='string')throw TypeError('Temporary directory prefix must be a path')
  if(!isLivePath(target))return Reflect.apply(fs.mkdtempSync,fs,[target,options])
  encodePathResult(target,options)
  for(let attempt=0;attempt<100;attempt++){
    const random=crypto.getRandomValues(new Uint8Array(6))
    const suffix=Array.from(random,byte=>'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[byte%62]).join('')
    const directory=target+suffix
    try{mkdirSync(directory,0o700)}catch(error){
      if((error as {code?:string}).code==='EEXIST')continue
      throw error
    }
    return encodePathResult(directory,options)
  }
  throw Object.assign(Error('Unable to create a unique temporary directory'),{code:'EEXIST'})
}
export const mkdtemp=pathReadCallback(mkdtempSync) as typeof fs.mkdtemp
function openFlags(flags:string|number):number{
  if(typeof flags==='number')return flags
  const c=fs.constants
  const table:Record<string,number>={
    r:c.O_RDONLY,'r+':c.O_RDWR,
    w:c.O_WRONLY|c.O_CREAT|c.O_TRUNC,'w+':c.O_RDWR|c.O_CREAT|c.O_TRUNC,
    wx:c.O_WRONLY|c.O_CREAT|c.O_TRUNC|c.O_EXCL,'wx+':c.O_RDWR|c.O_CREAT|c.O_TRUNC|c.O_EXCL,
    a:c.O_WRONLY|c.O_CREAT|c.O_APPEND,'a+':c.O_RDWR|c.O_CREAT|c.O_APPEND,
    ax:c.O_WRONLY|c.O_CREAT|c.O_APPEND|c.O_EXCL,'ax+':c.O_RDWR|c.O_CREAT|c.O_APPEND|c.O_EXCL,
  }
  if(!Object.hasOwn(table,flags))throw TypeError(`Invalid file open flag: ${flags}`)
  return table[flags]
}
export function openSync(path:unknown,flags:string|number,mode=0o666):number{
  const target=filePath(path)
  if(!isLivePath(target))return fs.openSync(target as never,flags as never,mode)
  const remote=liveFileClient!.call('open',[target,openFlags(flags),mode]) as number
  const fd=nextLiveDescriptor++
  liveDescriptors.set(fd,remote)
  return fd
}
export const open = ((path:unknown,flags:string|number,mode:unknown,callback?:Function)=>{
  const done=typeof mode==='function'?mode as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{let fd:number;try{fd=openSync(path,flags,typeof mode==='number'?mode:undefined)}catch(error){done(error);return}done(null,fd)})
}) as typeof fs.open
export function readSync(fd:number,buffer:Uint8Array,offset:number,length:number,position:number|null):number{
  const remote=liveDescriptors.get(fd)
  if(remote===undefined)return fs.readSync(fd,buffer,offset,length,position)
  if(!ArrayBuffer.isView(buffer)||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||
    offset<0||length<0||offset+length>buffer.byteLength)throw RangeError('Invalid read buffer range')
  let total=0
  while(total<length){
    const bytes=liveFileClient!.call('read',[remote,Math.min(65536,length-total),position===null?null:position+total]) as Uint8Array
    buffer.set(bytes,offset+total);total+=bytes.byteLength
    if(bytes.byteLength===0)break
  }
  return total
}
export const read = ((fd:number,buffer:Uint8Array,offset:number,length:number,position:number|null,callback:Function)=>{
  if(typeof callback!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{let count:number;try{count=readSync(fd,buffer,offset,length,position)}catch(error){callback(error);return}callback(null,count,buffer)})
}) as typeof fs.read
export const readdir = ((path:unknown,options:unknown,callback?:Function)=>{
  const done=typeof options==='function'?options as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{
    let entries:unknown
    try{entries=readdirSync(path,typeof options==='function'?undefined:options)}
    catch(error){done(error);return}
    done(null,entries)
  })
  }) as typeof fs.readdir
export function readdirSync(path:unknown,options?:unknown):unknown{
  const target=filePath(path)
  if(!isLivePath(target))
    return Reflect.apply(fs.readdirSync,fs,[target,options])
  const settings=typeof options==='object'&&options!==null?options as {withFileTypes?:boolean;recursive?:boolean;encoding?:BufferEncoding|'buffer'}:{}
  const encoding=typeof options==='string'?options:settings.encoding??'utf8'
  if(encoding!=='buffer'&&!Buffer.isEncoding(encoding))throw TypeError('Invalid directory encoding')
  const encode=(name:string)=>encoding==='buffer'?Buffer.from(name):Buffer.from(name).toString(encoding as BufferEncoding)
  const directories=[{path:target,relative:''}]
  const entries:unknown[]=[]
  for(const directory of directories){
    const names=liveClient().call('readdir',[directory.path]) as string[]
    for(const name of names){
      const relative=directory.relative?`${directory.relative}/${name}`:name
      const stat=settings.withFileTypes||settings.recursive?liveStat(`${directory.path}/${name}`,false):undefined
      if(settings.withFileTypes)entries.push(Object.assign(new fs.Dirent(),{
        name:encode(name),parentPath:directory.path,path:directory.path,mode:stat!.mode,
      }))
      else entries.push(encode(relative))
      if(settings.recursive&&stat!.isDirectory())directories.push({path:`${directory.path}/${name}`,relative})
    }
  }
  return entries
}
export const readFile = ((path:unknown,options:unknown,callback?:Function)=>{
  const done=typeof options==='function'?options as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{
    let value:unknown
    try{value=readFileSync(path,typeof options==='function'?undefined:options)}catch(error){done(error);return}
    done(null,value)
  })
}) as typeof fs.readFile
function pathReadCallback(read:(path:unknown,options?:unknown)=>unknown){
  return (path:unknown,options:unknown,callback?:Function)=>{
    const done=typeof options==='function'?options as Function:callback
    if(typeof done!=='function')throw TypeError('Callback must be a function')
    queueMicrotask(()=>{
      let value:unknown
      try{value=read(path,typeof options==='function'?undefined:options)}catch(error){done(error);return}
      done(null,value)
    })
  }
}
export function readlinkSync(path:unknown,options?:unknown):unknown{
  const target=filePath(path)
  if(!isLivePath(target))return Reflect.apply(fs.readlinkSync,fs,[target,options])
  return encodePathResult(liveFileClient!.call('readlink',[target]) as string,options)
}
export const readlink=pathReadCallback(readlinkSync) as typeof fs.readlink
export const realpath=Object.assign(pathReadCallback((path,options)=>realpathSync(path as never,options as never)),{
  native:pathReadCallback((path,options)=>realpathSync(path as never,options as never)),
}) as typeof fs.realpath
export const rename = ((source:unknown,target:unknown,callback:Function)=>
  callbackVoid(callback,()=>renameSync(source,target))) as typeof fs.rename
export function renameSync(oldPath:unknown,newPath:unknown):void{
  const source=filePath(oldPath),target=filePath(newPath)
  if(!isLivePath(source)||!isLivePath(target)){
    Reflect.apply(fs.renameSync,fs,[source,target]);return
  }
  liveClient().call('rename',[source,target])
}
export const rm = ((path:unknown,options:unknown,callback?:Function)=>{
  const done=typeof options==='function'?options as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{
    try{rmSync(path,typeof options==='function'?undefined:options)}catch(error){done(error);return}
    done(null)
  })
}) as typeof fs.rm
export function rmSync(path:unknown,options?:unknown):void{
  const target=filePath(path)
  if(!isLivePath(target)){Reflect.apply(fs.rmSync,fs,[target,options]);return}
  const settings=typeof options==='object'&&options?options as {recursive?:boolean;force?:boolean}:{}
  liveFileClient!.call('rm',[target,{recursive:settings.recursive===true,force:settings.force===true}])
}
export const rmdir = ((path:unknown,options:unknown,callback?:Function)=>{
  const done=typeof options==='function'?options as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{
    try{rmdirSync(path)}catch(error){done(error);return}
    done(null)
  })
}) as typeof fs.rmdir
export function rmdirSync(path:unknown):void{
  const target=filePath(path)
  if(!isLivePath(target)){Reflect.apply(fs.rmdirSync,fs,[target]);return}
  liveFileClient!.call('rmdir',[target])
}
export const stat = pathReadCallback((path,options)=>liveStat(path,true,options as NativeStatOptions|undefined)) as typeof fs.stat
export function statSync(path:unknown):NonNullable<ReturnType<typeof fs.statSync>>
export function statSync(path:unknown,options:NativeStatOptions):ReturnType<typeof liveStat>
export function statSync(path:unknown,options?:NativeStatOptions){return liveStat(path,true,options)}
export const symlink = bind(fs.symlink)
export const symlinkSync = bind(fs.symlinkSync)
export function truncateSync(path:unknown,length=0):void{
  const target=filePath(path)
  if(!isLivePath(target)){fs.truncateSync(target as never,length);return}
  liveFileClient!.call('truncate',[target,length])
}
export const truncate = ((path:unknown,length:unknown,callback?:Function)=>{
  const done=typeof length==='function'?length:callback
  callbackVoid(done,()=>truncateSync(path,typeof length==='number'?length:0))
}) as typeof fs.truncate
export const unlink = ((path:unknown,callback:Function)=>
  callbackVoid(callback,()=>unlinkSync(path))) as typeof fs.unlink
export function unlinkSync(path:unknown):void{
  const target=filePath(path)
  if(!isLivePath(target)){
    Reflect.apply(fs.unlinkSync,fs,[target]);return
  }
  liveClient().call('unlink',[target])
}
export function utimesSync(path:unknown,atime:unknown,mtime:unknown):void{
  const target=filePath(path)
  if(!isLivePath(target)){fs.utimesSync(target as never,atime as never,mtime as never);return}
  liveFileClient!.call('utimes',[target,fileTime(atime),fileTime(mtime)])
}
export const utimes = ((path:unknown,atime:unknown,mtime:unknown,callback:Function)=>
  callbackVoid(callback,()=>utimesSync(path,atime,mtime))) as typeof fs.utimes
const liveWatchers=new Set<LiveFSWatcher>()
class LiveFSWatcher extends EventEmitter{
  #closed=false
  #release:(()=>void)|undefined
  readonly #abort=()=>this.close()
  constructor(readonly target:string,readonly directory:boolean,
    readonly settings:{recursive?:boolean;persistent?:boolean;encoding?:BufferEncoding|'buffer';signal?:AbortSignal}){
    super()
    liveWatchers.add(this)
    if(settings.persistent===undefined||settings.persistent)this.ref()
    settings.signal?.addEventListener('abort',this.#abort,{once:true})
    if(settings.signal?.aborted)queueMicrotask(()=>this.close())
  }
  ref(){if(!this.#closed&&!this.#release)this.#release=keepNodeCommandAlive();return this}
  unref(){this.#release?.();this.#release=undefined;return this}
  close(){
    if(this.#closed)return
    this.#closed=true;this.unref();liveWatchers.delete(this)
    this.settings.signal?.removeEventListener('abort',this.#abort)
    queueMicrotask(()=>this.emit('close'))
  }
  notify(event:'change'|'rename',path:string){
    if(this.#closed)return
    let filename:string
    if(path===this.target)filename=browserPath.basename(path)
    else if(this.directory&&path.startsWith(this.target+'/')){
      filename=path.slice(this.target.length+1)
      if(!this.settings.recursive&&filename.includes('/'))return
    }else return
    const encoding=this.settings.encoding??'utf8'
    this.emit('change',event,encoding==='buffer'?Buffer.from(filename):Buffer.from(filename).toString(encoding))
  }
}
export function receiveNativeFileEvent(event:'change'|'rename',path:string){
  for(const watcher of [...liveWatchers])watcher.notify(event,path)
}
export const watch=((path:unknown,options:unknown,listener?:Function)=>{
  const target=filePath(path)
  if(!isLivePath(target))return Reflect.apply(fs.watch,fs,[target,options,listener])
  const invalid=(message:string)=>Object.assign(new TypeError(message),{code:'ERR_INVALID_ARG_TYPE'})
  if(options!==undefined&&options!==null&&typeof options!=='string'&&typeof options!=='object'&&typeof options!=='function')throw invalid('Options must be a string or object')
  const callback=typeof options==='function'?options:listener
  const settings=typeof options==='string'?{encoding:options}:typeof options==='object'&&options!==null?options:{}
  const typed=settings as {recursive?:boolean;persistent?:boolean;encoding?:BufferEncoding|'buffer';signal?:AbortSignal}
  if(typed.signal!==undefined&&(!typed.signal||typeof typed.signal.addEventListener!=='function'||typeof typed.signal.removeEventListener!=='function'||!('aborted' in typed.signal)))throw invalid('Options signal must be an AbortSignal')
  if(typed.encoding!==undefined&&typed.encoding!=='buffer'&&!Buffer.isEncoding(typed.encoding))throw TypeError('Invalid watch encoding')
  if(callback!==undefined&&typeof callback!=='function')throw TypeError('Listener must be a function')
  const watcher=new LiveFSWatcher(target as string,statSync(target).isDirectory(),typed)
  if(callback)watcher.on('change',callback as (...args:any[])=>void)
  return watcher
}) as typeof fs.watch
const liveStatWatchers=new Map<string,LiveStatWatcher>()
class LiveStatWatcher extends EventEmitter{
  #timer:ReturnType<typeof setInterval>
  #release:(()=>void)|undefined
  #stopped=false
  #previous:ReturnType<typeof toNodeStat>
  #lastExisting:ReturnType<typeof toNodeStat>|undefined
  #missingFirst:boolean
  constructor(readonly target:string,readonly settings:{interval:number;persistent:boolean;bigint:boolean}){
    super()
    this.#previous=this.#sample()
    if(this.#previous.nlink)this.#lastExisting=this.#previous
    this.#missingFirst=!this.#previous.nlink
    this.#timer=setInterval(()=>{
      const current=this.#sample(),observedPrevious=this.#previous
      const previous=!observedPrevious.nlink&&current.nlink?this.#lastExisting??observedPrevious:observedPrevious
      this.#previous=current
      if(current.nlink)this.#lastExisting=current
      if(this.#missingFirst||['mtimeMs','ctimeMs','size','ino','nlink','mode'].some(key=>
        (current as any)[key]!== (observedPrevious as any)[key]))this.emit('change',current,previous)
      this.#missingFirst=false
    },settings.interval)
    ;(this.#timer as unknown as {unref?:()=>void}).unref?.()
    if(settings.persistent)this.ref()
  }
  #sample(){
    try{return statSync(this.target,{bigint:this.settings.bigint})!}
    catch(error){
      if((error as {code?:string}).code!=='ENOENT')throw error
      const values:Omit<LiveStat,'kind'>={size:0,mode:0,dev:0,ino:0,nlink:0,uid:0,gid:0,rdev:0,blksize:0,blocks:0,
        atimeMs:0,mtimeMs:0,ctimeMs:0,birthtimeMs:0}
      return toNodeStat(values,this.settings.bigint)
    }
  }
  ref(){if(!this.#stopped&&!this.#release)this.#release=keepNodeCommandAlive();return this}
  unref(){this.#release?.();this.#release=undefined;return this}
  stop(){if(this.#stopped)return;this.#stopped=true;clearInterval(this.#timer);this.unref();this.emit('stop')}
}
export const watchFile=((path:unknown,options:unknown,listener?:Function)=>{
  const target=filePath(path)
  if(localProvider&&!isLivePath(target))return Reflect.apply(localProvider.fs.watchFile,localProvider.fs,[target,options,listener])
  const callback=typeof options==='function'?options:listener
  const settings=typeof options==='function'||options===undefined||options===null?{}:options
  const invalid=(message:string)=>Object.assign(new TypeError(message),{code:'ERR_INVALID_ARG_TYPE'})
  if(typeof settings!=='object')throw invalid('Options must be an object')
  if(typeof callback!=='function')throw invalid('Listener must be a function')
  const typed=settings as {interval?:number;persistent?:boolean;bigint?:boolean}
  const interval={interval:5007,...typed}.interval
  if(typeof interval!=='number')throw invalid('Interval must be a number')
  if(!Number.isInteger(interval)||interval<0||interval>0xffffffff)
    throw Object.assign(new RangeError('Invalid watch interval'),{code:'ERR_OUT_OF_RANGE'})
  const key=browserPath.resolve(target as string)
  let watcher=liveStatWatchers.get(key)
  if(!watcher){watcher=new LiveStatWatcher(key,{interval,persistent:typed.persistent===undefined?true:!!typed.persistent,bigint:!!typed.bigint});liveStatWatchers.set(key,watcher)}
  watcher.on('change',callback as (...args:any[])=>void)
  return watcher
}) as typeof memoryFilesystem.watchFile
function promiseWatch(path:unknown,options?:unknown):AsyncIterableIterator<{eventType:string;filename:unknown}>{
  const watcher=watch(path as never,options as never)
  const signal=typeof options==='object'&&options!==null?(options as {signal?:AbortSignal}).signal:undefined
  const queue:Array<{eventType:string;filename:unknown}>=[]
  const pending:Array<{resolve:(value:IteratorResult<{eventType:string;filename:unknown}>)=>void;reject:(error:unknown)=>void}>=[]
  let ended=false,failure:unknown
  const detach=()=>{
    watcher.removeListener('change',change);watcher.removeListener('error',error);watcher.removeListener('close',close)
    signal?.removeEventListener('abort',abort)
  }
  const finish=(reason?:unknown)=>{
    if(ended)return
    ended=true;failure=reason;queue.length=0;detach();watcher.close()
    for(const waiter of pending.splice(0))reason?waiter.reject(reason):waiter.resolve({done:true,value:undefined})
  }
  const change=(eventType:string,filename:unknown)=>{
    if(ended)return
    const value={eventType,filename},waiter=pending.shift()
    if(waiter)waiter.resolve({done:false,value});else queue.push(value)
  }
  const error=(reason:unknown)=>finish(reason)
  const close=()=>finish()
  const abort=()=>finish(Object.assign(new Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR',cause:signal?.reason}))
  watcher.on('change',change);watcher.on('error',error);watcher.on('close',close)
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
  return {
    [Symbol.asyncIterator](){return this},
    next(){
      if(failure)return Promise.reject(failure)
      if(ended)return Promise.resolve({done:true as const,value:undefined})
      if(queue.length)return Promise.resolve({done:false as const,value:queue.shift()!})
      return new Promise((resolve,reject)=>pending.push({resolve,reject}))
    },
    return(){finish();return Promise.resolve({done:true as const,value:undefined})},
    throw(reason){finish(reason);return Promise.reject(reason)},
  }
}
export const unwatchFile=((path:unknown,listener?:Function)=>{
  const target=filePath(path)
  if(localProvider&&!isLivePath(target))return Reflect.apply(localProvider.fs.unwatchFile,localProvider.fs,[target,listener])
  if(listener!==undefined&&typeof listener!=='function')throw Object.assign(new TypeError('Listener must be a function'),{code:'ERR_INVALID_ARG_TYPE'})
  const key=browserPath.resolve(target as string),watcher=liveStatWatchers.get(key)
  if(!watcher)return
  if(listener)watcher.removeListener('change',listener as (...args:any[])=>void)
  else watcher.removeAllListeners('change')
  if(!watcher.listenerCount('change')){liveStatWatchers.delete(key);watcher.stop()}
}) as typeof memoryFilesystem.unwatchFile
export function writeSync(fd:number,data:Uint8Array|string,offsetOrPosition?:number|null,lengthOrEncoding?:number|string,position?:number|null):number{
  const remote=liveDescriptors.get(fd)
  if(remote===undefined)return Reflect.apply(fs.writeSync,fs,[fd,data,offsetOrPosition,lengthOrEncoding,position]) as number
  const bytes=typeof data==='string'?Buffer.from(data,typeof lengthOrEncoding==='string'?lengthOrEncoding as BufferEncoding:undefined):
    data.subarray(offsetOrPosition??0,(offsetOrPosition??0)+(typeof lengthOrEncoding==='number'?lengthOrEncoding:data.byteLength-(offsetOrPosition??0)))
  const at=typeof data==='string'?offsetOrPosition??null:position??null
  let total=0
  while(total<bytes.byteLength){
    const count=liveFileClient!.call('write',[remote,bytes.slice(total,total+65536),at===null?null:at+total]) as number
    if(count<=0)throw Error('File write made no progress')
    total+=count
  }
  return total
}
export const write = ((fd:number,data:Uint8Array|string,offsetOrPosition:unknown,lengthOrEncoding:unknown,positionOrCallback:unknown,callback?:Function)=>{
  const done=[callback,positionOrCallback,lengthOrEncoding,offsetOrPosition].find(value=>typeof value==='function') as Function|undefined
  if(!done)throw TypeError('Callback must be a function')
  queueMicrotask(()=>{
    let count:number
    try{count=writeSync(fd,data,typeof offsetOrPosition==='number'?offsetOrPosition:undefined,
      typeof lengthOrEncoding==='number'||typeof lengthOrEncoding==='string'?lengthOrEncoding:undefined,
      typeof positionOrCallback==='number'?positionOrCallback:undefined)}catch(error){done(error);return}
    done(null,count,data)
  })
}) as typeof fs.write
export const writeFile = ((path:unknown,data:unknown,options:unknown,callback?:Function)=>{
  const done=typeof options==='function'?options as Function:callback
  if(typeof done!=='function')throw TypeError('Callback must be a function')
  queueMicrotask(()=>{
    try{writeFileSync(path,data,typeof options==='function'?undefined:options)}catch(error){done(error);return}
    done(null)
  })
}) as typeof fs.writeFile
export function writeFileSync(path:unknown,data:unknown,options?:unknown):void{
  const target=filePath(path)
  if(!isLivePath(target)){
    Reflect.apply(fs.writeFileSync,fs,[target,data,options]);return
  }
  const settings=typeof options==='string'?{encoding:options}:typeof options==='object'&&options?options as {encoding?:string;flag?:string;mode?:number}:{}
  const flag=settings.flag??'w'
  const flags:Record<string,number>={
    w:fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC,
    wx:fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_EXCL,
    a:fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND,
    ax:fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_EXCL,
  }
  if(!(flag in flags))throw Error(`Unsupported native worker file flag: ${flag}`)
  const bytes=typeof data==='string'?Buffer.from(data,settings.encoding as BufferEncoding|undefined):
    data instanceof Uint8Array?data:undefined
  if(!bytes)throw TypeError('Expected string or Uint8Array file contents')
  if(flag==='w'&&bytes.byteLength<=65536){
    liveClient().call('writeFile',[target,bytes,settings.mode])
    return
  }
  const fd=liveClient().call('open',[target,flags[flag],settings.mode??0o666]) as number
  try{
    for(let offset=0;offset<bytes.byteLength;offset+=65536)
      liveClient().call('write',[fd,bytes.slice(offset,offset+65536)])
  }finally{liveClient().call('close',[fd])}
}
export const constants = fs.constants
export const glob=bind(fs.glob)
export const globSync=bind(fs.globSync)
export const opendirSync=bind(fs.opendirSync)
export const opendir=bind(fs.opendir)
function trackedFileTask<T>(operation:()=>T):Promise<T>{
  return trackNodeCommandPromise(Promise.resolve().then(operation))
}
function openFileHandle(path:unknown,flags:string|number='r',mode=0o666){
  const fd=openSync(path,flags,mode)
  let closed=false
  const active=()=>{if(closed)throw Object.assign(Error('File handle is closed'),{code:'EBADF'})}
  const handle={
    get fd(){return closed?-1:fd},
    close:()=>trackedFileTask(()=>{if(closed)return;closed=true;closeSync(fd)}),
    sync:()=>trackedFileTask(()=>{active();fsyncSync(fd)}),
    datasync:()=>trackedFileTask(()=>{active();fdatasyncSync(fd)}),
    stat:(options?:{bigint?:boolean})=>trackedFileTask(()=>{active();return fstatSync(fd,options)}),
    chmod:(mode:number)=>trackedFileTask(()=>{active();fchmodSync(fd,mode)}),
    utimes:(atime:unknown,mtime:unknown)=>trackedFileTask(()=>{active();futimesSync(fd,atime,mtime)}),
    truncate:(length=0)=>trackedFileTask(()=>{active();ftruncateSync(fd,length)}),
    read:(bufferOrOptions?:Uint8Array|{buffer?:Uint8Array;offset?:number;length?:number;position?:number|null},
      offset?:number,length?:number,position?:number|null)=>trackedFileTask(()=>{
      active()
      const options=bufferOrOptions instanceof Uint8Array?{buffer:bufferOrOptions,offset,length,position}:bufferOrOptions??{}
      const buffer=options.buffer??Buffer.alloc(16384)
      const bytesRead=readSync(fd,buffer,options.offset??0,options.length??buffer.byteLength-(options.offset??0),options.position??null)
      return {bytesRead,buffer}
    }),
    write:(data:Uint8Array|string,offsetOrPosition?:number|null,lengthOrEncoding?:number|string,position?:number|null)=>
      trackedFileTask(()=>{active();const bytesWritten=writeSync(fd,data,offsetOrPosition,lengthOrEncoding,position);return {bytesWritten,buffer:data}}),
    readFile:(options?:string|{encoding?:string})=>trackedFileTask(()=>{
      active()
      const chunks:Uint8Array[]=[]
      for(;;){
        const buffer=Buffer.alloc(65536),count=readSync(fd,buffer,0,buffer.byteLength,null)
        if(count===0)break
        chunks.push(buffer.subarray(0,count))
      }
      const bytes=Buffer.concat(chunks)
      const encoding=typeof options==='string'?options:options?.encoding
      return encoding?bytes.toString(encoding as BufferEncoding):bytes
    }),
    writeFile:(data:Uint8Array|string,options?:string|{encoding?:string})=>trackedFileTask(()=>{
      active()
      const encoding=typeof options==='string'?options:options?.encoding
      const bytes=typeof data==='string'?Buffer.from(data,encoding as BufferEncoding|undefined):data
      writeSync(fd,bytes,0,bytes.byteLength,null)
    }),
  }
  return handle
}
const promiseOverrides:Record<string,Function>={
  watch:promiseWatch,
  access:async(path:unknown,mode?:number)=>accessSync(path,mode),
  readFile:async(path:unknown,options?:unknown)=>readFileSync(path,options),
  writeFile:async(path:unknown,data:unknown,options?:unknown)=>writeFileSync(path,data,options),
  stat:async(path:unknown,options?:NativeStatOptions)=>options?statSync(path,options):statSync(path),
  lstat:async(path:unknown,options?:NativeStatOptions)=>options?lstatSync(path,options):lstatSync(path),
  readdir:async(path:unknown,options?:unknown)=>readdirSync(path,options),
  readlink:async(path:unknown,options?:unknown)=>readlinkSync(path,options),
  realpath:async(path:unknown,options?:unknown)=>realpathSync(path as never,options as never),
  mkdir:async(path:unknown,options?:unknown)=>mkdirSync(path,options),
  mkdtemp:async(prefix:unknown,options?:unknown)=>mkdtempSync(prefix,options),
  unlink:async(path:unknown)=>unlinkSync(path),
  rename:async(source:unknown,destination:unknown)=>renameSync(source,destination),
  appendFile:async(path:unknown,data:unknown,options?:unknown)=>appendFileSync(path,data,options),
  copyFile:async(source:unknown,target:unknown,flags?:unknown)=>copyFileSync(source,target,flags),
  cp:async(source:unknown,target:unknown,options?:unknown)=>cpSync(source,target,options),
  rm:async(path:unknown,options?:unknown)=>rmSync(path,options),
  rmdir:async(path:unknown)=>rmdirSync(path),
  chmod:async(path:unknown,mode:number)=>chmodSync(path,mode),
  utimes:async(path:unknown,atime:unknown,mtime:unknown)=>utimesSync(path,atime,mtime),
  truncate:async(path:unknown,length?:number)=>truncateSync(path,length),
  open:async(path:unknown,flags:string|number='r',mode=0o666)=>{
    const target=filePath(path)
    return isLivePath(target)?openFileHandle(target,flags,mode):fs.promises.open(target as never,flags as never,mode)
  },
}
export const promises = new Proxy(fs.promises,{
  get(target,property,receiver){
    const override=typeof property==='string'?promiseOverrides[property]:undefined
    const value=override??Reflect.get(target,property,receiver)
    if(typeof value!=='function')return value
    return (...args:unknown[])=>{
      const result=Reflect.apply(value,override?undefined:target,args)
      return result&&typeof (result as Promise<unknown>).then==='function'
        ?trackNodeCommandPromise(result as Promise<unknown>):result
    }
  },
})
export const Stats = fs.Stats
export const Dirent = fs.Dirent
export const Dir = remoteProvider?.fs.Dir

export function readFileSync(path: unknown, options?: unknown): unknown {
  if (String(path).endsWith('bindings_wasm_bg.wasm')) {
    const bytes = (globalThis as typeof globalThis & { __rollupWasmBytes?: Uint8Array }).__rollupWasmBytes
    if (!bytes) throw new Error('Rollup WASM was not initialized')
    const encoding = typeof options === 'string'
      ? options
      : (options as { encoding?: string } | undefined)?.encoding
    return encoding ? Buffer.from(bytes).toString(encoding as never) : Buffer.from(bytes)
  }
  const target=filePath(path)
  if(isLivePath(target)){
    const fd=liveClient().call('open',[target,fs.constants.O_RDONLY,0]) as number
    const chunks:Uint8Array[]=[]
    try{
      for(;;){
        const chunk=liveClient().call('read',[fd,65536]) as Uint8Array
        if(!chunk.byteLength)break
        chunks.push(chunk)
      }
    }finally{liveClient().call('close',[fd])}
    const bytes=Buffer.concat(chunks)
    const encoding=typeof options==='string'?options:typeof options==='object'&&options?(options as {encoding?:string}).encoding:undefined
    return encoding?bytes.toString(encoding as BufferEncoding):bytes
  }
  return fs.readFileSync(target as never, options as never)
}

function encodePathResult(value:string,options?:unknown){
  const encoding=typeof options==='string'?options:typeof options==='object'&&options?
    (options as {encoding?:string}).encoding:undefined
  if(encoding==='buffer')return Buffer.from(value)
  return encoding?Buffer.from(value).toString(encoding as BufferEncoding):value
}
const liveRealpathSync=((path:unknown,options?:unknown)=>{
  const target=filePath(path)
  if(!isLivePath(target))return Reflect.apply(fs.realpathSync,fs,[target,options])
  const resolved=liveFileClient!.call('realpath',[target]) as string
  return encodePathResult(resolved,options)
}) as typeof fs.realpathSync
export const realpathSync=Object.assign(liveRealpathSync,{native:liveRealpathSync})

export function resetVolume(files: Record<string, string | Uint8Array>): void {
  // A mount replaces directory contents, not the filesystem namespace itself.
  // Compiler WASI preopens the root before the first workspace is mounted.
  // Retaining that inode also keeps ordinary open-file unlink semantics intact.
  for(const name of fs.readdirSync('/'))fs.rmSync(`/${name}`,{recursive:true,force:true})
  fs.mkdirSync('/app', { recursive: true })
  fs.mkdirSync('/dist/client', { recursive: true })
  fs.writeFileSync('/dist/client/client.mjs', typeof __VITE_CLIENT_ENTRY__ === 'string' ? __VITE_CLIENT_ENTRY__ : '')
  fs.writeFileSync('/dist/client/env.mjs', typeof __VITE_ENV_ENTRY__ === 'string' ? __VITE_ENV_ENTRY__ : '')
  if(typeof __BROWSER_VITE_PACKAGE_JSON__==='string'){
    fs.mkdirSync('/__toolchain/vite/dist/client',{recursive:true})
    fs.writeFileSync('/__toolchain/vite/package.json',__BROWSER_VITE_PACKAGE_JSON__)
    fs.writeFileSync('/__toolchain/vite/dist/client/client.mjs',typeof __VITE_CLIENT_ENTRY__==='string'?__VITE_CLIENT_ENTRY__:'')
    fs.writeFileSync('/__toolchain/vite/dist/client/env.mjs',typeof __VITE_ENV_ENTRY__==='string'?__VITE_ENV_ENTRY__:'')
  }
  for (const [path, contents] of Object.entries(files)) {
    const normalized = path.startsWith('/') ? path : `/app/${path}`
    fs.mkdirSync(normalized.slice(0, normalized.lastIndexOf('/')) || '/', { recursive: true })
    fs.writeFileSync(normalized, contents)
  }
}

export function readVolume(prefix = '/app'): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {}
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (typeof entry !== 'object' || !('name' in entry) || !('isDirectory' in entry)) {
        throw new Error('Expected a directory entry from memfs')
      }
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) visit(path)
      else if(entry.isFile())result[path] = Uint8Array.from(fs.readFileSync(path) as Uint8Array)
    }
  }
  if (fs.existsSync(prefix)) visit(prefix)
  return result
}

/** Preserve the filesystem shape as well as bytes for persistent workspaces. */
export function snapshotVolume(prefix = '/app'): Extract<WorkspaceSnapshot,{version:5}> {
  const files:Record<string,Uint8Array>={}
  const directories:string[]=[]
  const symlinks:Record<string,string>={}
  const fileModes:Record<string,number>={}
  const directoryModes:Record<string,number>={}
  const fileTimes:Record<string,{atimeMs:number;mtimeMs:number}>={}
  const directoryTimes:Record<string,{atimeMs:number;mtimeMs:number}>={}
  const visit=(directory:string)=>{
    directories.push(directory)
    const directoryStat=fs.lstatSync(directory)
    directoryModes[directory]=directoryStat.mode&0o7777
    directoryTimes[directory]={atimeMs:directoryStat.atimeMs,mtimeMs:directoryStat.mtimeMs}
    for(const name of fs.readdirSync(directory) as string[]){
      const path=`${directory}/${name}`
      const stat=fs.lstatSync(path)
      if(stat.isSymbolicLink())symlinks[path]=fs.readlinkSync(path) as string
      else if(stat.isDirectory())visit(path)
      else if(stat.isFile()){
        files[path]=Uint8Array.from(fs.readFileSync(path) as Uint8Array)
        fileModes[path]=stat.mode&0o7777
        fileTimes[path]={atimeMs:stat.atimeMs,mtimeMs:stat.mtimeMs}
      }else throw Error(`Unsupported workspace entry: ${path}`)
    }
  }
  if(fs.existsSync(prefix))visit(prefix)
  return {version:5,files,directories,symlinks,fileModes,directoryModes,fileTimes,directoryTimes}
}

export function restoreVolumeSnapshot(snapshot:WorkspaceSnapshot):void {
  const valid=(path:string)=>path==='/app'||path.startsWith('/app/')&&
    !path.slice('/app/'.length).split('/').some(part=>!part||part==='.'||part==='..')
  for(const path of Object.keys(snapshot.files))if(!valid(path)||path==='/app')throw Error(`Invalid snapshot file: ${path}`)
  if(snapshot.version!==1)for(const path of snapshot.directories)if(!valid(path))throw Error(`Invalid snapshot directory: ${path}`)
  if('symlinks' in snapshot)for(const path of Object.keys(snapshot.symlinks))if(!valid(path)||path==='/app')throw Error(`Invalid snapshot symlink: ${path}`)
  if('fileModes' in snapshot)for(const path of Object.keys(snapshot.fileModes))if(!valid(path)||path==='/app')throw Error(`Invalid snapshot file mode: ${path}`)
  if('directoryModes' in snapshot)for(const path of Object.keys(snapshot.directoryModes))if(!valid(path))throw Error(`Invalid snapshot directory mode: ${path}`)
  if(snapshot.version===5){
    const validateTimes=(times:Record<string,{atimeMs:number;mtimeMs:number}>|undefined,paths:string[],label:string)=>{
      if(times===undefined)return
      if(!times||typeof times!=='object'||Array.isArray(times)||Object.keys(times).length!==paths.length)
        throw Error(`Invalid snapshot ${label} times`)
      const allowed=new Set(paths)
      for(const [path,value] of Object.entries(times)){
        if(!allowed.has(path)||!value||typeof value!=='object'||Array.isArray(value)||
          !Number.isFinite(value.atimeMs)||!Number.isFinite(value.mtimeMs)||
          Math.abs(value.atimeMs)>8.64e15||Math.abs(value.mtimeMs)>8.64e15)
          throw Error(`Invalid snapshot ${label} time: ${path}`)
      }
    }
    validateTimes(snapshot.fileTimes,Object.keys(snapshot.files),'file')
    validateTimes(snapshot.directoryTimes,snapshot.directories,'directory')
  }
  resetVolume(snapshot.files)
  if(snapshot.version===1)return
  for(const path of [...snapshot.directories].sort((a,b)=>a.length-b.length)){
    fs.mkdirSync(path,{recursive:true})
  }
  if('symlinks' in snapshot){
    for(const [path,target] of Object.entries(snapshot.symlinks)){
      fs.symlinkSync(target,path)
    }
  }
  if('fileModes' in snapshot)for(const [path,mode] of Object.entries(snapshot.fileModes))fs.chmodSync(path,mode)
  if('directoryModes' in snapshot)for(const [path,mode] of Object.entries(snapshot.directoryModes))fs.chmodSync(path,mode)
  if(snapshot.version===5){
    if(snapshot.fileTimes)for(const [path,time] of Object.entries(snapshot.fileTimes))
      fs.utimesSync(path,new Date(time.atimeMs),new Date(time.mtimeMs))
    if(snapshot.directoryTimes)for(const [path,time] of Object.entries(snapshot.directoryTimes).sort((a,b)=>b[0].length-a[0].length))
      fs.utimesSync(path,new Date(time.atimeMs),new Date(time.mtimeMs))
  }
}

export default {...fs,ReadStream,WriteStream,open,openSync,close,closeSync,fsync,fsyncSync,fdatasync,fdatasyncSync,read,readSync,write,writeSync,fstat,fstatSync,
  access,accessSync,watch,watchFile,unwatchFile,lstat,stat,mkdir,mkdtemp,mkdtempSync,readdir,rename,unlink,readlink,readlinkSync,realpath,
  chmod,chmodSync,fchmod,fchmodSync,utimes,utimesSync,futimes,futimesSync,
  truncate,truncateSync,ftruncate,ftruncateSync,
  createReadStream,createWriteStream,
  readFile,readFileSync,writeFile,writeFileSync,appendFile,appendFileSync,
  copyFile,copyFileSync,cp,cpSync,existsSync,lstatSync,mkdirSync,readdirSync,renameSync,rm,rmSync,
  rmdir,rmdirSync,statSync,realpathSync,unlinkSync,promises}
