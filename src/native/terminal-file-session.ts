import type {NativeFileOperations} from './filesystem-operations'
import path from 'path-browserify'

type ShellStat={name:string;size:number;mode:number;dev:number;ino:number;nlink:number;uid:number;gid:number;
  rdev:number;blksize:number;blocks:number;atimeMs:number;mtimeMs:number;ctimeMs:number;birthtimeMs:number;
  kind:'directory'|'file'|'symlink'}

/** File descriptors owned by one shell invocation, backed by the preview worker's volume. */
export class NativeTerminalFileSession {
  readonly changedPaths=new Set<string>()
  get workspaceChangedPaths(){return [...this.changedPaths].filter(path=>path==='/app'||path.startsWith('/app/'))}
  #descriptors=new Map<number,string>()
  constructor(private volume:NativeFileOperations){volume.mkdirSync('/tmp',{recursive:true,mode:0o1777})}
  resolvePath(input:string,cwd='/app'){
    if(typeof input!=='string'||!input||input.includes('\0'))throw Error('Invalid shell path')
    const translated=input==='/project'?'/app':input.startsWith('/project/')?'/app'+input.slice('/project'.length):input
    const base=this.#path(cwd)
    return this.#path(path.resolve(base,translated))
  }
  #path(input:unknown,allowFinalLink=false){
    if(typeof input!=='string'||!input.startsWith('/')||input.includes('\0'))throw Error('Invalid shell path')
    const translated=input==='/project'?'/app':input.startsWith('/project/')?'/app'+input.slice('/project'.length):input
    const resolved=path.normalize(translated)
    if(resolved!=='/app'&&!resolved.startsWith('/app/')&&resolved!=='/tmp'&&!resolved.startsWith('/tmp/'))throw Object.assign(Error('Cannot leave the container filesystem'),{code:'ERR_OUTSIDE_CONTAINER_PATH'})
    let segment=''
    for(const part of resolved.split('/').filter(Boolean)){
      segment+='/'+part
      try{if(this.volume.lstatSync(segment).isSymbolicLink()&&!(allowFinalLink&&segment===resolved))throw Error(`Cannot follow a symbolic link: ${input}`)}
      catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
    }
    return resolved
  }
  #stat(input:unknown,follow:boolean):ShellStat{
    const name=this.#path(input,!follow)
    const stat=follow?this.volume.statSync(name):this.volume.lstatSync(name)
    return this.#statValue(name,stat)
  }
  #statValue(name:string,stat:{size:number;mode:number;dev:number;ino:number;nlink:number;uid:number;gid:number;
    rdev:number;blksize:number;blocks:number;atimeMs:number;mtimeMs:number;ctimeMs:number;birthtimeMs:number;
    isDirectory():boolean;isSymbolicLink():boolean}):ShellStat{
    return {name:path.basename(name),size:stat.size,mode:stat.mode,dev:stat.dev,ino:stat.ino,nlink:stat.nlink,
      uid:stat.uid,gid:stat.gid,rdev:stat.rdev,blksize:stat.blksize,blocks:stat.blocks,
      atimeMs:stat.atimeMs,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,birthtimeMs:stat.birthtimeMs,
      kind:stat.isDirectory()?'directory':stat.isSymbolicLink()?'symlink':'file'}
  }
  call(method:string,args:unknown[]):unknown{
    if(method==='access'){
      const mode=args[1]
      if(typeof mode!=='number'||!Number.isInteger(mode)||mode<0||mode>7)throw TypeError('Invalid access mode')
      this.volume.accessSync(this.#path(args[0]),mode)
      return
    }
    if(method==='stat')return this.#stat(args[0],true)
    if(method==='lstat')return this.#stat(args[0],false)
    if(method==='realpath')return String(this.volume.realpathSync(this.#path(args[0])))
    if(method==='readlink')return String(this.volume.readlinkSync(this.#path(args[0],true)))
    if(method==='readdir')return this.volume.readdirSync(this.#path(args[0])).map(String)
    if(method==='readFile')return new Uint8Array(this.volume.readFileSync(this.#path(args[0])) as Uint8Array)
    if(method==='writeFile'){
      const target=this.#path(args[0]),bytes=args[1],mode=args[2]
      if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)throw Error('Invalid shell write bytes')
      if(mode!==undefined&&(typeof mode!=='number'||!Number.isSafeInteger(mode)||mode<0||mode>0o7777))throw Error('Invalid shell write mode')
      this.volume.writeFileSync(target,bytes,mode===undefined?undefined:{mode})
      this.changedPaths.add(target)
      return
    }
    if(method==='mkdir'){
      const target=this.#path(args[0]),recursive=args[1]
      if(typeof recursive!=='boolean')throw Error('Invalid recursive flag')
      const mode=args[2]??0o777
      if(typeof mode!=='number'||!Number.isInteger(mode)||mode<0||mode>0xffffffff)throw TypeError('Invalid directory mode')
      let firstCreated:string|undefined
      if(recursive){
        let candidate=''
        for(const part of target.split('/').filter(Boolean)){
          candidate+='/'+part
          if(!this.volume.existsSync(candidate)){firstCreated=candidate;break}
        }
      }
      this.volume.mkdirSync(target,{recursive,mode})
      this.changedPaths.add(target)
      return firstCreated
    }
    if(method==='unlink'){
      const target=this.#path(args[0])
      this.volume.unlinkSync(target)
      this.changedPaths.add(target)
      return
    }
    if(method==='rename'){
      const source=this.#path(args[0]),target=this.#path(args[1])
      this.volume.renameSync(source,target)
      this.changedPaths.add(source)
      this.changedPaths.add(target)
      return
    }
    if(method==='copyFile'){
      const source=this.#path(args[0]),target=this.#path(args[1]),flags=args[2]
      if(typeof flags!=='number'||!Number.isSafeInteger(flags))throw Error('Invalid copy flags')
      this.volume.copyFileSync(source,target,flags)
      this.changedPaths.add(target)
      return
    }
    if(method==='cp'){
      const source=this.#path(args[0]),target=this.#path(args[1]),options=args[2]
      if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Invalid copy options')
      const settings=options as Record<string,unknown>
      for(const [key,value] of Object.entries(settings)){
        if(!['recursive','force','errorOnExist','dereference','preserveTimestamps','mode'].includes(key) ||
          (key==='mode'?typeof value!=='number':typeof value!=='boolean'))throw Error('Unsupported copy option')
      }
      const inspect=(name:string)=>{
        this.#path(name)
        if(!this.volume.existsSync(name)||!this.volume.lstatSync(name).isDirectory())return
        for(const child of this.volume.readdirSync(name).map(String))inspect(path.join(name,child))
      }
      inspect(source)
      inspect(target)
      this.volume.cpSync(source,target,settings)
      this.changedPaths.add(target)
      return
    }
    if(method==='rm'){
      const target=this.#path(args[0]),options=args[1]
      if(!options||typeof options!=='object')throw Error('Invalid remove options')
      const {recursive,force}=options as {recursive?:unknown;force?:unknown}
      if(typeof recursive!=='boolean'||typeof force!=='boolean')throw Error('Invalid remove options')
      this.volume.rmSync(target,{recursive,force})
      this.changedPaths.add(target)
      return
    }
    if(method==='rmdir'){
      const target=this.#path(args[0])
      this.volume.rmdirSync(target)
      this.changedPaths.add(target)
      return
    }
    if(method==='chmod'||method==='utimes'||method==='truncate'){
      const target=this.#path(args[0])
      if(method==='chmod')this.volume.chmodSync(target,this.#mode(args[1]))
      else if(method==='utimes')this.volume.utimesSync(target,this.#time(args[1]),this.#time(args[2]))
      else this.volume.truncateSync(target,this.#length(args[1]))
      this.changedPaths.add(target)
      return
    }
    if(method==='open'){
      if(this.#descriptors.size>=64)throw Error('Shell descriptor limit exceeded')
      const target=this.#path(args[0]),flags=args[1]
      if(typeof flags!=='number'||!Number.isSafeInteger(flags))throw Error('Invalid shell open flags')
      const mode=typeof args[2]==='number'?args[2]:0o666
      const fd=this.volume.openSync(target,flags,mode)
      this.#descriptors.set(fd,target)
      // O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND may mutate the file.
      if(flags&0o3303)this.changedPaths.add(target)
      return fd
    }
    const fd=args[0]
    if(typeof fd!=='number'||!this.#descriptors.has(fd))throw Error('Unknown shell descriptor')
    if(method==='close'){
      this.volume.closeSync(fd);this.#descriptors.delete(fd);return
    }
    if(method==='fstat')return this.#statValue(this.#descriptors.get(fd)!,this.volume.fstatSync(fd))
    if(method==='fsync'){this.volume.fsyncSync(fd);return}
    if(method==='fdatasync'){this.volume.fdatasyncSync(fd);return}
    if(method==='fchmod'||method==='futimes'||method==='ftruncate'){
      if(method==='fchmod')this.volume.fchmodSync(fd,this.#mode(args[1]))
      else if(method==='futimes')this.volume.futimesSync(fd,this.#time(args[1]),this.#time(args[2]))
      else this.volume.ftruncateSync(fd,this.#length(args[1]))
      this.changedPaths.add(this.#descriptors.get(fd)!)
      return
    }
    if(method==='read'){
      const length=args[1],position=args[2]??null
      if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||length>65536)throw Error('Invalid shell read length')
      if(position!==null&&(typeof position!=='number'||!Number.isSafeInteger(position)||position<0))throw Error('Invalid shell read position')
      const bytes=new Uint8Array(length)
      const count=this.volume.readSync(fd,bytes,0,length,position)
      return bytes.slice(0,count)
    }
    if(method==='write'){
      const bytes=args[1],position=args[2]??null
      if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)throw Error('Invalid shell write bytes')
      if(position!==null&&(typeof position!=='number'||!Number.isSafeInteger(position)||position<0))throw Error('Invalid shell write position')
      this.changedPaths.add(this.#descriptors.get(fd)!)
      return this.volume.writeSync(fd,bytes,0,bytes.byteLength,position)
    }
    throw Error(`Unsupported shell file operation: ${method}`)
  }
  close(){
    for(const fd of this.#descriptors.keys())this.volume.closeSync(fd)
    this.#descriptors.clear()
  }
  #mode(value:unknown){
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>0o7777)throw Error('Invalid file mode')
    return value
  }
  #time(value:unknown){
    if(typeof value!=='number'||!Number.isFinite(value))throw Error('Invalid file time')
    return new Date(value*1000)
  }
  #length(value:unknown){
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('Invalid file length')
    return value
  }
}
