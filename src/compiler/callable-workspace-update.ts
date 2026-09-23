import {captureBundlerFiles} from './rolldown-bundler-workspace'

/** Apply an ordered watcher notification to the owned compiler mirror. Multiple
 * plugins may receive the same notification, so mutations are idempotent. */
export function updateCallableWorkspace(fs:any,path:string,bytes:Uint8Array|undefined,event:string,limits:{maxBytes:number;maxFiles:number}){
  if(typeof path!=='string'||path.length>4096||!path.startsWith('/')||path.includes('\0')||path.split('/').slice(1).some(part=>!part||part==='.'||part==='..')||!['create','update','delete'].includes(event))throw Error('Invalid callable workspace event')
  if(event==='delete'?bytes!==undefined:!(bytes instanceof Uint8Array))throw Error('Invalid callable workspace bytes')
  const parts=path.split('/').slice(1)
  let prefix='',missingParents=0
  for(let i=0;i<parts.length;i++){
    prefix+='/'+parts[i]
    try{
      const stat=fs.lstatSync(prefix)
      if(stat.isSymbolicLink()||(i===parts.length-1?!stat.isFile():!stat.isDirectory()))throw Error('Unsupported callable workspace path')
    }catch(error:any){if(error?.code!=='ENOENT')throw error;if(i<parts.length-1)missingParents++}
  }
  const files=captureBundlerFiles(fs,limits),previous=files[path]
  if(event==='delete'){
    if(previous)fs.unlinkSync(path)
    return
  }
  const total=Object.values(files).reduce((sum,value)=>sum+value.byteLength,0)-(previous?.byteLength??0)+bytes!.byteLength
  let entries=0
  const count=(directory:string)=>{for(const name of fs.readdirSync(directory)){
    const entry=directory==='/'?'/'+name:directory+'/'+name
    entries++
    if(fs.lstatSync(entry).isDirectory())count(entry)
  }}
  count('/')
  if(total>limits.maxBytes||entries+missingParents+(previous?0:1)>limits.maxFiles)throw Error('Callable workspace quota exceeded')
  fs.mkdirSync(path.slice(0,path.lastIndexOf('/'))||'/',{recursive:true})
  fs.writeFileSync(path,bytes)
}
