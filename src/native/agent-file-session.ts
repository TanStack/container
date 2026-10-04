import type {NativeOwnerClient} from './owner-transport'

export type NativeAgentFileBackend=Pick<NativeOwnerClient,'listDirectory'|'mkdir'|'remove'|'rename'>
/** The four file-session operations used by agent tools, backed by native owner APIs. */
export class NativeAgentFileSession {
  #closed=false
  constructor(private backend:NativeAgentFileBackend,private writable=false){}
  async call(method:string,args:unknown[]):Promise<unknown>{
    if(this.#closed)throw Error('EBADF: file session closed')
    const path=(value:unknown)=>{
      if(typeof value!=='string'||!value.startsWith('/')||value.includes('\\')||value.includes('\0')||new TextEncoder().encode(value).length>4096||value.split('/').some((part,index)=>index>0&&(!part||part==='.'||part==='..')))throw Error('Invalid native file path')
      return value
    }
    if(method==='readdir'){
      const root=path(args[0]),options=args[1] as {recursive?:boolean;withFileTypes?:boolean}|undefined
      if(!options||options.recursive!==true||options.withFileTypes!==true)throw Error('Agent directory listing requires recursive file types')
      const entries:Array<{name:string;relativePath:string;kind:'file'|'directory'|'symlink'}>=[]
      const pending=[{path:root,relative:''}]
      while(pending.length){
        if(this.#closed)throw Error('EBADF: file session closed')
        const directory=pending.pop()!
        const children=await this.backend.listDirectory(directory.path)
        if(this.#closed)throw Error('EBADF: file session closed')
        for(const child of children){
          if(!child.name||child.name==='.'||child.name==='..'||/[\/\\\0]/.test(child.name))throw Error('Invalid native directory entry')
          if(!['file','directory','symlink'].includes(child.type))throw Error('Invalid native directory entry type')
          const relativePath=directory.relative?directory.relative+'/'+child.name:child.name
          entries.push({name:child.name,relativePath,kind:child.type})
          if(child.type==='directory')pending.push({path:directory.path.replace(/\/$/,'')+'/'+child.name,relative:relativePath})
        }
      }
      return entries.sort((a,b)=>a.relativePath.localeCompare(b.relativePath))
    }
    if(!['mkdir','rm','rename'].includes(method))throw Object.assign(Error('Unsupported native agent file operation: '+method),{code:'ERR_NOT_IMPLEMENTED'})
    if(!this.writable)throw Error('Native agent file session is read-only')
    if(method==='rename')return this.backend.rename(path(args[0]),path(args[1]))
    const target=path(args[0]),options=args[1]
    if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Invalid native file options')
    if(method==='mkdir')return this.backend.mkdir(target,options as {recursive?:boolean;mode?:number})
    return this.backend.remove(target,options as {recursive?:boolean;force?:boolean})
  }
  async close(){this.#closed=true}
}
