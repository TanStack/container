import {WorkspaceFiles,workspacePath} from './files'

export type ModuleKind='module'|'commonjs'|'json'|'builtin'
export interface ResolvedModule {id:string;path:string;kind:ModuleKind}
type Target=string|null|Target[]|{[key:string]:Target}
const parent=(path:string)=>path.slice(0,path.lastIndexOf('/'))||'/'
const join=(root:string,path:string)=>workspacePath(root+'/'+path)
const fileURL=(path:string)=>{
  const url=new URL('file:///')
  url.pathname=path.replaceAll('%','%25').replaceAll('?','%3F').replaceAll('#','%23').replaceAll('\n','%0A').replaceAll('\r','%0D').replaceAll('\t','%09')
  return url
}
export const moduleError=(code:string,message:string)=>Object.assign(new Error(message),{code})

// Node-shaped resolution for the worker's POSIX filesystem. This path does not
// use browser-field remapping or extension guessing for ESM relative imports.
export class ModuleResolver {
  #revision=-1
  #metadataCache=new Map<string,any>()
  constructor(readonly files:WorkspaceFiles,readonly builtins:Set<string>){}
  #metadata(path:string):any {
    if(this.#revision!==this.files.revision){this.#metadataCache.clear();this.#revision=this.files.revision}
    if(this.#metadataCache.has(path))return this.#metadataCache.get(path)
    if(!this.files.isFileSync(path))return undefined
    const bytes=this.files.readFileSync(path)
    if(bytes.length>1024*1024)throw moduleError('ERR_PACKAGE_METADATA_LIMIT','package.json exceeds the 1 MiB metadata limit')
    try{const data=JSON.parse(new TextDecoder().decode(bytes));this.#metadataCache.set(path,data);return data}
    catch{throw moduleError('ERR_INVALID_PACKAGE_CONFIG','Invalid package.json: '+path)}
  }
  #scope(path:string):{root:string;data:any}|undefined {
    let directory=parent(path)
    for(;;){
      if(directory.endsWith('/node_modules'))return undefined
      const data=this.#metadata(join(directory,'package.json'))
      if(data)return {root:directory,data}
      if(directory==='/')return undefined
      directory=parent(directory)
    }
  }
  #file(path:string):string|undefined {
    for(const suffix of ['', '.js','.json','.node'])if(this.files.isFileSync(path+suffix))return path+suffix
  }
  #legacy(path:string,seen=new Set<string>()):string|undefined {
    const file=this.#file(path);if(file)return file
    if(seen.has(path))return undefined
    seen.add(path)
    const data=this.#metadata(join(path,'package.json'))
    if(typeof data?.main==='string'){
      const target=join(path,data.main)
      const entry=this.#file(target)??this.#file(join(target,'index'))
      if(entry)return entry
    }
    return this.#file(join(path,'index'))
  }
  #target(target:Target,conditions:Set<string>,wildcard?:string,exportsMap=true):string|null|undefined {
    if(target===null)return null
    if(typeof target==='string'){
      const value=wildcard===undefined?target:target.replaceAll('*',wildcard)
      if(value.startsWith('./'))this.#packageTarget('/',value)
      else if(exportsMap||value.startsWith('.')||value.startsWith('/'))throw moduleError('ERR_INVALID_PACKAGE_TARGET','Package exports must target a relative file')
      return value
    }
    if(Array.isArray(target)){
      if(!target.length)return null
      let last:Error|null|undefined
      for(const candidate of target){
        try{const result=this.#target(candidate,conditions,wildcard,exportsMap);if(result===null){last=null;continue}if(result!==undefined)return result}
        catch(error){if((error as any).code!=='ERR_INVALID_PACKAGE_TARGET')throw error;last=error as Error}
      }
      if(last instanceof Error)throw last
      return last
    }
    if(!target||typeof target!=='object')throw moduleError('ERR_INVALID_PACKAGE_TARGET','Invalid package target')
    if(Object.keys(target).some(key=>String(Number(key))===key&&Number.isInteger(Number(key))&&Number(key)>=0&&Number(key)<4294967295))throw moduleError('ERR_INVALID_PACKAGE_CONFIG','Numeric package conditions are not allowed')
    for(const [condition,value] of Object.entries(target))if(condition==='default'||conditions.has(condition)){
      const result=this.#target(value,conditions,wildcard,exportsMap);if(result!==undefined)return result
    }
  }
  #map(map:Target,key:string,conditions:Set<string>,exportsMap:boolean):string|null|undefined {
    if(typeof map==='string'||map===null||Array.isArray(map))return key==='.'?this.#target(map,conditions):undefined
    if(!map||typeof map!=='object')throw moduleError('ERR_INVALID_PACKAGE_CONFIG','Invalid package map')
    const keys=Object.keys(map)
    if(exportsMap){
      const subpaths=keys.filter(k=>k.startsWith('.'))
      if(subpaths.length&&subpaths.length!==keys.length)throw moduleError('ERR_INVALID_PACKAGE_CONFIG','Mixed exports conditions and subpaths')
      if(!subpaths.length)return key==='.'?this.#target(map,conditions):undefined
    }
    if(Object.hasOwn(map,key)&&!key.includes('*'))return this.#target(map[key],conditions,undefined,exportsMap)
    const patterns=keys.filter(k=>k.includes('*')).sort((a,b)=>b.indexOf('*')-a.indexOf('*')||b.length-a.length)
    for(const pattern of patterns){
      const [prefix,suffix]=pattern.split('*')
      if(key.startsWith(prefix)&&key.endsWith(suffix)&&key.length>=prefix.length+suffix.length)
        return this.#target(map[pattern],conditions,key.slice(prefix.length,key.length-suffix.length),exportsMap)
    }
  }
  #packageTarget(root:string,target:string):string {
    if(!target.startsWith('./'))throw moduleError('ERR_INVALID_PACKAGE_TARGET','Package exports must target a relative file')
    for(const segment of target.slice(2).split(/[?#]/,1)[0].split('/')){
      let decoded:string
      try{decoded=decodeURIComponent(segment)}catch{throw moduleError('ERR_INVALID_PACKAGE_TARGET','Invalid target encoding')}
      if(['.','..','node_modules'].includes(decoded)||decoded.includes('/')||decoded.includes('\\'))
        throw moduleError('ERR_INVALID_PACKAGE_TARGET','Package target escapes its scope')
    }
    return new URL(target,fileURL(root.replace(/\/$/,'')+'/')).href
  }
  #resolveTarget(root:string,target:string,mode:'import'|'require'):ResolvedModule {
    const url=this.#packageTarget(root,target),path=this.fromURL(url)
    return this.#describe(path,mode==='import'?url:path)
  }
  #describe(path:string,id=path):ResolvedModule {
    if(!this.files.isFileSync(path)){
      if(this.files.isDirectorySync(path))throw moduleError('ERR_UNSUPPORTED_DIR_IMPORT','Cannot import directory: '+path)
      throw moduleError('MODULE_NOT_FOUND','Cannot find module: '+path)
    }
    path=this.files.realpathSync(path)
    if(id.startsWith('file:')){const original=new URL(id),canonical=fileURL(path);canonical.search=original.search;canonical.hash=original.hash;id=canonical.href}else id=path
    if(path.endsWith('.node'))throw moduleError('ERR_DLOPEN_DISABLED','Native addons cannot run in this kernel: '+path)
    const kind=path.endsWith('.json')?'json':path.endsWith('.mjs')?'module':path.endsWith('.cjs')?'commonjs':this.#scope(path)?.data.type==='module'?'module':'commonjs'
    return {id,path,kind}
  }
  resolve(specifier:string,importer='/entry.mjs',mode:'import'|'require'='import',depth=0):ResolvedModule {
    const record=this.#resolve(specifier,importer,mode,depth)
    if(mode==='import'&&record.kind!=='builtin'&&!record.id.startsWith('file:')){
      record.id=fileURL(record.path).href
    }
    return record
  }
  #resolve(specifier:string,importer:string,mode:'import'|'require',depth:number):ResolvedModule {
    if(depth>64)throw moduleError('ERR_INVALID_PACKAGE_TARGET','Package import cycle')
    if(typeof specifier!=='string'||!specifier||specifier.includes('\0')||specifier.includes('\\'))throw moduleError('ERR_INVALID_MODULE_SPECIFIER','Invalid module specifier')
    const builtin=specifier.startsWith('node:')?specifier:'node:'+specifier
    if(this.builtins.has(builtin))return {id:builtin,path:builtin,kind:'builtin'}
    if(specifier.startsWith('node:'))throw moduleError('ERR_UNKNOWN_BUILTIN_MODULE','Unsupported Node builtin: '+specifier)
    if(importer.startsWith('file:'))importer=this.fromURL(importer)
    if(!importer.startsWith('/'))importer='/entry.mjs'
    const conditions=new Set(['node',mode,'module-sync'])
    if(specifier.startsWith('file:')){
      const url=new URL(specifier),path=this.fromURL(specifier)
      return this.#describe(path,mode==='import'?url.href:path)
    }
    if(specifier==='.'||specifier==='..'||specifier.startsWith('/')||specifier.startsWith('./')||specifier.startsWith('../')){
      if(mode==='import'){
        const url=new URL(specifier,fileURL(importer)),path=this.fromURL(url.href)
        return this.#describe(path,url.href)
      }
      const path=specifier.startsWith('/')?workspacePath(specifier):join(parent(importer),specifier)
      const entry=this.#legacy(path)
      if(!entry)throw moduleError('MODULE_NOT_FOUND','Cannot find module: '+path)
      return this.#describe(entry)
    }
    if(/^[a-zA-Z][\w+.-]*:/.test(specifier))throw moduleError('ERR_UNSUPPORTED_ESM_URL_SCHEME','Unsupported module URL: '+specifier)
    const scope=this.#scope(importer)
    if(specifier.startsWith('#')){
      if(specifier==='#'||specifier.startsWith('#/'))throw moduleError('ERR_INVALID_MODULE_SPECIFIER','Invalid package import')
      const target=scope?.data.imports&&this.#map(scope.data.imports,specifier,conditions,false)
      if(!target)throw moduleError('ERR_PACKAGE_IMPORT_NOT_DEFINED','Package import is not defined: '+specifier)
      if(target.startsWith('./'))return this.#resolveTarget(scope!.root,target,mode)
      if(target.startsWith('.')||target.startsWith('/')||target.startsWith('#'))throw moduleError('ERR_INVALID_PACKAGE_TARGET','Invalid package import target')
      return this.resolve(target,join(scope!.root,'package.json'),mode,depth+1)
    }
    const parts=specifier.split('/'),name=parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0]
    if(!name||name.includes('%')||name.startsWith('.')||(name.startsWith('@')&&parts.length<2))throw moduleError('ERR_INVALID_MODULE_SPECIFIER','Invalid package name')
    const subpath=parts.slice(name.startsWith('@')?2:1).join('/'),key=subpath?'./'+subpath:'.'
    const roots:string[]=[]
    if(scope?.data.name===name&&scope.data.exports!==undefined)roots.push(scope.root)
    for(let directory=parent(importer);;directory=parent(directory)){
      if(!directory.endsWith('/node_modules'))roots.push(join(directory,'node_modules/'+name))
      if(directory==='/')break
    }
    for(const root of roots){
      const data=this.#metadata(join(root,'package.json'))
      if(data?.exports!==undefined){
        const target=this.#map(data.exports,key,conditions,true)
        if(!target)throw moduleError('ERR_PACKAGE_PATH_NOT_EXPORTED','Package subpath is not exported: '+specifier)
        return this.#resolveTarget(root,target,mode)
      }
      const path=subpath?join(root,subpath):root
      const entry=mode==='require'||!subpath?this.#legacy(path):this.files.isFileSync(path)?path:undefined
      if(entry)return this.#describe(entry)
    }
    throw moduleError('MODULE_NOT_FOUND','Cannot find package: '+specifier)
  }
  fromURL(value:string):string {
    const url=new URL(value)
    if(url.protocol!=='file:'||url.hostname&&url.hostname!=='localhost'||/%2f|%5c/i.test(url.pathname))throw moduleError('ERR_INVALID_FILE_URL_PATH','Invalid workspace file URL')
    return workspacePath(decodeURIComponent(url.pathname))
  }
  describe(id:string):ResolvedModule {
    if(this.builtins.has(id))return {id,path:id,kind:'builtin'}
    return this.#describe(id.startsWith('file:')?this.fromURL(id):id,id)
  }
}
