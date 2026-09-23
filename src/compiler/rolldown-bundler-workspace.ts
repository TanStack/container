import {WorkspaceFiles,type WorkspaceSnapshot} from '../sandbox/files'
import {restoreCompilerWorkspace} from './restore-compiler-workspace'
/** Called only in the shared session's ordered build lane, with no build active.
 * fs is the owned memfs volume, never the host filesystem. */
export function synchronizeBundlerWorkspace(fs:any,snapshot:WorkspaceSnapshot,limits:{maxBytes:number;maxFiles:number}){
  const validated=new WorkspaceFiles({},limits.maxBytes,limits.maxFiles)
  try{
    validated.replace(snapshot)
    const normalized=validated.snapshot()
    // Complete validation before replacing the owned mirror. Existing native
    // resolver instances are preserved, including upstream cache semantics.
    for(const name of fs.readdirSync('/'))fs.rmSync('/'+name,{recursive:true,force:false})
    const restored=restoreCompilerWorkspace(fs,normalized,limits)
    return {bytes:restored.bytes,files:Object.keys(normalized.files)}
  }finally{validated.close()}
}
export function captureBundlerFiles(fs:any,limits:{maxBytes:number;maxFiles:number}):Record<string,Uint8Array>{
  const files:Record<string,Uint8Array>=Object.create(null)
  let bytes=0,count=0
  const visit=(directory:string)=>{
    for(const name of fs.readdirSync(directory)){
      const path=directory==='/'?'/'+name:directory+'/'+name,stat=fs.lstatSync(path)
      if(stat.isSymbolicLink())continue
      if(stat.isDirectory())visit(path)
      else if(stat.isFile()){
        if(++count>limits.maxFiles||(bytes+=stat.size)>limits.maxBytes)throw Error('Native bundler workspace exceeds owner policy')
        files[path]=new Uint8Array(fs.readFileSync(path))
      }else throw Error('Unsupported native bundler filesystem entry')
    }
  }
  visit('/');return files
}
/** Guard ordinary WASI synchronous writes before allocation. Recompute metadata
 * so truncate, unlink and descriptor writes share the same quota accounting. */
export function guardBundlerWrites(fs:any,limits:{maxBytes:number;maxFiles:number}){
  const original={writeSync:fs.writeSync,writeFileSync:fs.writeFileSync,openSync:fs.openSync,closeSync:fs.closeSync}
  const positions=new Map<number,number>()
  const usage=()=>{
    let bytes=0,files=0
    const visit=(directory:string)=>{for(const name of fs.readdirSync(directory)){
      const path=directory==='/'?'/'+name:directory+'/'+name,stat=fs.lstatSync(path)
      if(stat.isSymbolicLink())continue
      if(stat.isDirectory())visit(path)
      else if(stat.isFile()){bytes+=stat.size;files++}
    }}
    visit('/');return {bytes,files}
  }
  const check=(growth:number,created=0)=>{const used=usage();if(used.bytes+growth>limits.maxBytes||used.files+created>limits.maxFiles)throw Object.assign(Error('Native bundler workspace quota exceeded'),{code:'ENOSPC'})}
  fs.openSync=function(path:string,flags:number|string,...rest:unknown[]){
    const creates=typeof flags==='number'?Boolean(flags&fs.constants.O_CREAT):/[wa]/.test(flags)
    if(creates&&!fs.existsSync(path))check(0,1)
    const fd=original.openSync.call(fs,path,flags,...rest)
    positions.set(fd,typeof flags==='string'&&flags.startsWith('a')||typeof flags==='number'&&Boolean(flags&fs.constants.O_APPEND)?fs.fstatSync(fd).size:0)
    return fd
  }
  fs.closeSync=function(fd:number){try{return original.closeSync.call(fs,fd)}finally{positions.delete(fd)}}
  fs.writeSync=function(fd:number,buffer:Uint8Array,offset:number,length:number,position:number|null){
    if(!(buffer instanceof Uint8Array)||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>buffer.length)throw Error('Unsupported native bundler write shape')
    const at=position??positions.get(fd)
    if(!Number.isSafeInteger(at)||at!<0)throw Error('Unknown native bundler descriptor position')
    check(Math.max(0,at!+length-fs.fstatSync(fd).size))
    const written=original.writeSync.call(fs,fd,buffer,offset,length,position)
    if(position===null||position===undefined)positions.set(fd,at!+written)
    return written
  }
  fs.writeFileSync=function(path:string,value:Uint8Array|string,...args:unknown[]){
    const size=typeof value==='string'?new TextEncoder().encode(value).byteLength:value.byteLength
    const exists=fs.existsSync(path),previous=exists?fs.statSync(path).size:0
    check(Math.max(0,size-previous),exists?0:1)
    return original.writeFileSync.call(fs,path,value,...args)
  }
  return ()=>{Object.assign(fs,original);positions.clear()}
}
