import type {NativeFileOperations} from './filesystem-operations'
import {dirname,normalizePath} from '../fs/path'
import type {VirtualFileSystem} from '../fs/types'
import {writeFileWithParents} from './write-file-with-parents.mjs'

/** Async package-installer view of the same volume used by native modules. */
export class VolumeFileSystem implements VirtualFileSystem{
  constructor(readonly volume:NativeFileOperations){}
  async exists(path:string){return this.volume.existsSync(normalizePath(path))}
  async isFile(path:string){
    try{return this.volume.statSync(normalizePath(path)).isFile()}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
  }
  async realpath(path:string){return this.volume.realpathSync(normalizePath(path)).toString()}
  async list(prefix='/'){
    const root=normalizePath(prefix)
    const files:string[]=[],pending=[root]
    while(pending.length){
      const path=pending.pop()!
      let stat:{isFile():boolean;isDirectory():boolean}
      try{stat=this.volume.lstatSync(path)}
      catch(error){if(path===root&&(error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
      if(stat.isFile())files.push(path)
      else if(stat.isDirectory()){
        for(const name of this.volume.readdirSync(path))pending.push((path==='/'?'':path)+'/'+String(name))
      }
    }
    return files.sort()
  }
  async readFile(path:string){return new Uint8Array(this.volume.readFileSync(normalizePath(path)) as Uint8Array)}
  async readText(path:string){return new TextDecoder().decode(await this.readFile(path))}
  async writeFile(path:string,contents:Uint8Array,options:{followSymlinks?:boolean;mode?:number}={}){
    const target=normalizePath(path)
    if('writeFileWithParentsSync' in this.volume&&typeof this.volume.writeFileWithParentsSync==='function')
      this.volume.writeFileWithParentsSync(target,contents,options)
    else writeFileWithParents(this.volume,target,contents,options)
  }
  async writeText(path:string,contents:string){await this.writeFile(path,new TextEncoder().encode(contents))}
  async symlink(target:string,path:string){
    const link=normalizePath(path),resolved=normalizePath(target)
    if(resolved!=='/app'&&!resolved.startsWith('/app/'))throw Error('Package executable target leaves the workspace')
    this.volume.mkdirSync(dirname(link),{recursive:true})
    this.volume.symlinkSync(resolved,link)
  }
  async chmod(path:string,mode:number){this.volume.chmodSync(normalizePath(path),mode)}
}
