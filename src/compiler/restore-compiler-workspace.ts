import {WorkspaceFiles,type WorkspaceSnapshot} from '../sandbox/files'

export interface CompilerFileSystem {
  readdirSync(path:string):unknown[]
  mkdirSync(path:string,options:{recursive:true}):unknown
  writeFileSync(path:string,bytes:Uint8Array):unknown
  symlinkSync(target:string,path:string):unknown
  chmodSync(path:string,mode:number):unknown
}

/** Restore into a fresh compiler filesystem. Live updates need a separate ordered
 * protocol and resolver cache invalidation, not replacement under active calls.
 */
export function restoreCompilerWorkspace(fs:CompilerFileSystem,snapshot:WorkspaceSnapshot,limits:{maxBytes:number;maxFiles:number}){
  const validated=new WorkspaceFiles({},limits.maxBytes,limits.maxFiles)
  try{
    validated.replace(snapshot)
    const captured=validated.snapshot()
    if(captured.version!==5)throw Error('Expected normalized workspace snapshot')
    if(fs.readdirSync('/').length)throw Error('Compiler filesystem must be empty')
    for(const path of [...captured.directories].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b)))fs.mkdirSync(path,{recursive:true})
    for(const [path,bytes] of Object.entries(captured.files))fs.writeFileSync(path,bytes)
    for(const [path,target] of Object.entries(captured.symlinks))fs.symlinkSync(target,path)
    for(const [path,mode] of Object.entries(captured.fileModes))fs.chmodSync(path,mode)
    for(const [path,mode] of Object.entries(captured.directoryModes))fs.chmodSync(path,mode)
    return {files:Object.keys(captured.files).length,bytes:Object.values(captured.files).reduce((total,bytes)=>total+bytes.byteLength,0)}
  }finally{validated.close()}
}
