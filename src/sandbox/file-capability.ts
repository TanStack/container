import { validateWorkspacePath, type WorkspaceFiles } from './files'

// The host owns path checks and write authority, never the guest's shim.
export async function fileCall(
  fs: WorkspaceFiles,
  writable: boolean,
  method: string,
  args: unknown[],
) {
  return fileCallSync(fs,writable,method,args)
}

// A worker that owns the filesystem can serve guest synchronous calls directly.
// Both entry points enforce the same authority and path rules.
export function fileCallSync(fs:WorkspaceFiles,writable:boolean,method:string,args:unknown[]) {
  try{return performFileCall(fs,writable,method,args)}catch(error){
    if(error instanceof Error){const code=/^(EACCES|EINVAL|ENOENT|ENOTDIR|EISDIR|EEXIST|ENOSPC|ENAMETOOLONG|ENOTEMPTY|EBUSY|ENOTSUP|ELOOP):/.exec(error.message)?.[1];if(code)Object.assign(error,{code,path:args[0]})}
    throw error
  }
}
function performFileCall(fs:WorkspaceFiles,writable:boolean,method:string,args:unknown[]) {
  if (!Array.isArray(args) || typeof args[0] !== 'string')
    throw new Error('Invalid filesystem request')
  validateWorkspacePath(args[0]);const path=args[0]
  if(method==='access'){
    const mode=args[1]??0
    if(typeof mode!=='number'||!Number.isInteger(mode)||mode<0||mode>7)throw new TypeError('Invalid access mode')
    if(!fs.existsSync(path))throw new Error(`ENOENT: ${path}`)
    if(mode&2&&!writable)throw new Error(`EACCES: ${path}`)
    if(mode&1&&!(fs.statSync(path).mode&0o111))throw new Error(`EACCES: file is not executable: ${path}`)
    return
  }
  if(method==='exists')return fs.existsSync(path)
  if(method==='realpath'){
    return fs.realpathSync(path)
  }
  if(method==='readlink')return fs.readlinkSync(path)
  if(method==='symlink'){
    if(!writable)throw new Error('EACCES: read-only process')
    if(args[2]!=null&&!['file','dir','junction'].includes(args[2] as string))throw new Error('EINVAL: invalid symbolic link type')
    return fs.symlinkSync(args[1] as string,path)
  }
  if(method==='chmod'){
    if(!writable)throw new Error('EACCES: read-only process')
    return fs.chmodSync(path,args[1])
  }
  if (method === 'readFile') {
    const option = args[1]
    const encoding =
      typeof option === 'string'
        ? option
        : (option as { encoding?: string } | undefined)?.encoding
    if (encoding && encoding !== 'utf8' && encoding !== 'utf-8')
      throw new Error('Unsupported encoding')
    const bytes=fs.readFileSync(path)
    return encoding ? new TextDecoder().decode(bytes) : bytes
  }
  if (method === 'writeFile') {
    if (!writable) throw new Error('EACCES: read-only process')
    if (!(args[1] instanceof Uint8Array)) throw new Error('Expected file bytes')
    const option=args[2],flag=typeof option==='object'&&option!==null?(option as {flag?:unknown}).flag??'w':'w'
    const settings=option as {mode?:unknown;flush?:unknown;signal?:unknown}|undefined
    if(settings?.flush||settings?.signal!==undefined)throw new Error('ENOTSUP: flush and abort signals are not implemented')
    if(!['w','wx','w+','wx+','a','ax','a+','ax+','r+'].includes(String(flag)))throw new Error('EINVAL: unsupported write flag')
    if(String(flag).includes('x')&&fs.entryExistsSync(path))throw new Error(`EEXIST: ${path}`)
    if(flag==='r+'&&!fs.existsSync(path))throw new Error(`ENOENT: ${path}`)
    let bytes=args[1]
    if((String(flag).startsWith('a')||flag==='r+')&&fs.isFileSync(path)){
      const before=fs.readFileSync(path),offset=String(flag).startsWith('a')?before.length:0
      const size=Math.max(before.length,offset+bytes.length)
      if(fs.byteLength-before.length+size>fs.maxBytes)throw new Error('ENOSPC: workspace byte quota exceeded')
      const next=new Uint8Array(size);next.set(before);next.set(bytes,offset);bytes=next
    }
    return fs.writeFileSync(path, bytes,false,true,settings?.mode)
  }
  if (method === 'stat'||method==='lstat') {
    return fs.statSync(path,method==='stat')
  }
  if (method === 'readdir') {
    const option=args[1],o=typeof option==='string'?{encoding:option}:option as {encoding?:string;withFileTypes?:boolean;recursive?:boolean}|undefined
    if(o?.recursive!==undefined&&typeof o.recursive!=='boolean'||o?.withFileTypes!==undefined&&typeof o.withFileTypes!=='boolean')throw new TypeError('Invalid readdir option')
    if(o?.encoding&&!['utf8','utf-8','buffer'].includes(o.encoding))throw new Error('EINVAL: unsupported directory encoding')
    const entries=fs.readdirSync(path,o?.recursive)
    return o?.withFileTypes?entries:entries.map(entry=>entry.relativePath)
  }
  if(['mkdir','rmdir','rm','unlink','rename','copyFile','truncate'].includes(method)){
    if(!writable)throw new Error('EACCES: read-only process')
    if(method==='mkdir'){
      const o=args[1] as {recursive?:boolean;mode?:number|string}|number|string|undefined
      if(typeof o==='object'&&o?.recursive!==undefined&&typeof o.recursive!=='boolean')throw new TypeError('Invalid recursive option')
      return fs.mkdirSync(path,typeof o==='object'&&o!==null?o.recursive:false,typeof o==='object'&&o!==null?o.mode:o)
    }
    if(method==='unlink')return fs.unlinkSync(path)
    if(method==='rmdir'){
      if(args[1]&&Object.keys(args[1] as object).length)throw new Error('ENOTSUP: rmdir options are not implemented')
      return fs.rmdirSync(path)
    }
    if(method==='rm'){
      const o=(args[1]??{}) as {recursive?:boolean;force?:boolean}
      if(typeof o!=='object'||o.recursive!==undefined&&typeof o.recursive!=='boolean'||o.force!==undefined&&typeof o.force!=='boolean')throw new TypeError('Invalid rm options')
      return fs.rmSync(path,o)
    }
    if(method==='rename')return fs.renameSync(path,args[1] as string)
    if(method==='copyFile'){
      const target=args[1] as string,flags=args[2]??0
      validateWorkspacePath(target)
      if(typeof flags!=='number'||!Number.isInteger(flags)||flags<0||flags>7)throw new Error('EINVAL: invalid copy flags')
      if(flags&4)throw new Error('ENOTSUP: reflinks are not supported')
      const bytes=fs.readFileSync(path)
      if(flags&1&&fs.entryExistsSync(target))throw new Error(`EEXIST: ${target}`)
      if(target!==path)return fs.writeFileSync(target,bytes,false)
      return
    }
    if(method==='truncate'){
      const length=args[1]??0
      if(typeof length!=='number'||!Number.isSafeInteger(length))throw new Error('EINVAL: invalid file length')
      const before=fs.readFileSync(path),size=Math.max(0,length)
      if(fs.byteLength-before.length+size>fs.maxBytes)throw new Error('ENOSPC: workspace byte quota exceeded')
      const bytes=new Uint8Array(size);bytes.set(before.subarray(0,size));return fs.writeFileSync(path,bytes,false)
    }
  }
  throw new Error(`Unsupported filesystem operation: ${method}`)
}
