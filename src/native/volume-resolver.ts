import type {Plugin} from 'vite'
import {dirname,join,normalize} from '../vite-browser/node-path'
import {existsSync,statSync,readFileSync} from '../vite-browser/node-fs'
import JSON5 from 'json5'
import {isBuiltin} from '../vite-browser/node-module'

const extensions=['','.js','.mjs','.cjs','.ts','.mts','.tsx','.jsx','.json']
export const isContainerModulePath=(value:string)=>value.startsWith('/app/')||value.startsWith('/tmp/')
interface ExportConditions{[condition:string]:ExportTarget}
type ExportTarget=string|null|ExportTarget[]|ExportConditions
const clientConditions=new Set(['browser','development','module','import','default'])
const serverConditions=new Set(['node','development','module','import','default'])

function selectExport(target:ExportTarget,conditions:Set<string>,subpath=''):string|null|undefined{
  if(typeof target==='string')return target.replaceAll('*',subpath)
  if(target===null)return null
  if(Array.isArray(target)){
    for(const entry of target){const selected=selectExport(entry,conditions,subpath);if(selected!==undefined)return selected}
    return
  }
  for(const [condition,entry] of Object.entries(target)){
    if(!conditions.has(condition))continue
    const selected=selectExport(entry,conditions,subpath)
    if(selected!==undefined)return selected
  }
}

function packageExport(exports:ExportTarget,key:string,conditions:Set<string>):string|null|undefined{
  if(typeof exports!=='object'||exports===null||Array.isArray(exports))return key==='.'?selectExport(exports,conditions):undefined
  const entries=exports as Record<string,ExportTarget>
  if(!Object.keys(entries).some(entry=>entry.startsWith('.')))return key==='.'?selectExport(exports,conditions):undefined
  if(Object.hasOwn(entries,key))return selectExport(entries[key],conditions)
  for(const [pattern,target] of Object.entries(entries)){
    const star=pattern.indexOf('*')
    if(star<0)continue
    const prefix=pattern.slice(0,star),suffix=pattern.slice(star+1)
    if(key.startsWith(prefix)&&key.endsWith(suffix)){
      const matched=key.slice(prefix.length,key.length-suffix.length)
      return selectExport(target,conditions,matched)
    }
  }
}

function packageImportTarget(imports:Record<string,ExportTarget>,key:string,conditions:Set<string>):string|null|undefined{
  if(Object.hasOwn(imports,key))return selectExport(imports[key],conditions)
  for(const [pattern,target] of Object.entries(imports)){
    const star=pattern.indexOf('*')
    if(star<0)continue
    const prefix=pattern.slice(0,star),suffix=pattern.slice(star+1)
    if(key.startsWith(prefix)&&key.endsWith(suffix))
      return selectExport(target,conditions,key.slice(prefix.length,key.length-suffix.length))
  }
}

function existingFile(candidate:string):string|undefined{
  if(!isContainerModulePath(candidate))return
  // A live existsSync already performs a stat round trip. Inspect each path
  // once, and retain only this resolution's candidate metadata, never a cache.
  const candidateStat=statSync(candidate,{throwIfNoEntry:false})
  if(candidateStat?.isFile())return candidate
  for(const extension of extensions.slice(1)){
    const filename=candidate+extension
    if(statSync(filename,{throwIfNoEntry:false})?.isFile())return filename
  }
  if(candidateStat?.isDirectory()){
    for(const extension of extensions.slice(1)){
      const filename=join(candidate,'index'+extension)
      if(statSync(filename,{throwIfNoEntry:false})?.isFile())return filename
    }
  }
}

function resolveTsconfigPath(id:string):string|undefined{
  const configPath='/app/tsconfig.json'
  if(!existsSync(configPath))return
  const config=JSON5.parse(readFileSync(configPath,'utf8') as string) as {
    compilerOptions?:{baseUrl?:string;paths?:Record<string,string[]>}
  }
  const options=config.compilerOptions
  if(!options?.paths)return
  const base=normalize(join('/app',options.baseUrl??'.'))
  if(base!=='/app'&&!base.startsWith('/app/'))throw Error('tsconfig baseUrl escaped workspace')
  const mappings=Object.entries(options.paths).sort(([a],[b])=>b.replace('*','').length-a.replace('*','').length)
  for(const [pattern,targets] of mappings){
    const star=pattern.indexOf('*')
    const prefix=star<0?pattern:pattern.slice(0,star)
    const suffix=star<0?'':pattern.slice(star+1)
    if(star<0?id!==pattern:!id.startsWith(prefix)||!id.endsWith(suffix))continue
    const matched=star<0?'':id.slice(prefix.length,id.length-suffix.length)
    for(const target of targets){
      const candidate=normalize(join(base,target.replaceAll('*',matched)))
      const resolved=existingFile(candidate)
      if(resolved)return resolved
    }
  }
}

function resolvePackage(id:string,importer:string,conditions:Set<string>):string|undefined{
  const parts=id.split('/')
  const name=id.startsWith('@')?parts.slice(0,2).join('/'):parts[0]
  if(!name)return
  const subpath=parts.slice(name.startsWith('@')?2:1).join('/')
  for(let directory=dirname(importer);isContainerModulePath(directory+'/');directory=dirname(directory)){
    const root=join(directory,'node_modules',name)
    const manifest=join(root,'package.json')
    if(existsSync(manifest)){
      const data=JSON.parse(readFileSync(manifest,'utf8') as string) as {
        exports?:ExportTarget;browser?:string|Record<string,string|false>;module?:string;main?:string
      }
      const exported=data.exports!==undefined
      let target=exported
        ?packageExport(data.exports!,subpath?'./'+subpath:'.',conditions)
        :subpath?'./'+subpath:(conditions.has('browser')&&typeof data.browser==='string'?data.browser:undefined)||data.module||data.main||'index.js'
      if(!target)return
      if(conditions.has('browser')&&data.browser&&typeof data.browser==='object'){
        const mapped=data.browser[target.startsWith('./')?target:'./'+target]
        if(typeof mapped==='string')target=mapped
        else if(mapped===false)return
      }
      if(exported&&!target.startsWith('./'))throw Error(`Invalid package target for ${id}: ${target}`)
      if(!exported&&(target.startsWith('/')||target.startsWith('..')))throw Error(`Invalid package entry for ${id}: ${target}`)
      const candidate=normalize(join(root,target))
      if(!candidate.startsWith(root+'/'))throw Error(`Package target escaped its package: ${id}`)
      return existingFile(candidate)
    }
    if(directory==='/app'||directory==='/tmp')break
  }
}

function resolvePackageImport(id:string,importer:string,conditions:Set<string>):string|undefined{
  for(let directory=dirname(importer);isContainerModulePath(directory+'/');directory=dirname(directory)){
    const manifest=join(directory,'package.json')
    if(existsSync(manifest)){
      const data=JSON.parse(readFileSync(manifest,'utf8') as string) as {imports?:Record<string,ExportTarget>}
      const target=data.imports&&packageImportTarget(data.imports,id,conditions)
      if(!target)return
      if(target.startsWith('node:'))throw Error(`Invalid package import target: ${target}`)
      if(isBuiltin(target))return `node:${target}`
      if(!target.startsWith('./'))return resolvePackage(target,importer,conditions)
      const candidate=normalize(join(directory,target))
      if(!candidate.startsWith(directory+'/'))throw Error(`Package import escaped its scope: ${id}`)
      return existingFile(candidate)
    }
    if(directory==='/app'||directory==='/tmp')break
  }
}

/** Resolve package-private imports with the caller's exact import or require conditions. */
export function resolveVolumePrivateImport(id:string,importer:string,conditions:Iterable<string>):string|undefined{
  if(!id.startsWith('#')||!isContainerModulePath(importer))return
  return resolvePackageImport(id,importer,new Set(conditions))
}

/** Resolve a server module synchronously for import.meta.resolve. */
export function resolveVolumeImport(id:string,importer:string,consumer:'client'|'server'='server',additionalConditions?:Iterable<string>):string|undefined{
  if(!isContainerModulePath(importer))return
  // Node builtins win over installed packages. Client resolution still needs
  // to allow browser packages and the project's normal plugin behavior.
  if(consumer==='server'&&isBuiltin(id))return id.startsWith('node:')?id:`node:${id}`
  const conditions=new Set(consumer==='client'?clientConditions:serverConditions)
  for(const condition of additionalConditions??[])conditions.add(condition)
  if(id.startsWith('#'))return resolvePackageImport(id,importer,conditions)
  if(id.startsWith('.'))return existingFile(normalize(join(dirname(importer),id)))
  if(isContainerModulePath(id))return existingFile(normalize(id))
  if(id.startsWith('/'))return existingFile(normalize(join('/app',id)))
  if(id.startsWith('node_modules/'))return existingFile(normalize(join('/app',id)))
  const installed=resolvePackage(id,importer,conditions)
  if(installed)return installed
  if((importer==='/app/__virtual__.js'||importer==='/app/__entry__.js')&&id.includes('/'))
    return existingFile(normalize(join('/app',id)))
}

/** Makes the worker-owned project volume visible to Vite's module resolver. */
export function volumeResolver():Plugin{
  return {
    name:'browser-native-volume-resolver',
    enforce:'pre',
    configResolved(config){
      const createResolver=config.createResolver.bind(config)
      const createWorkspaceResolver:typeof config.createResolver=(options)=>{
        const resolve=createResolver(options)
        return async(id,importer,aliasOnly,ssr)=>{
          const resolved=await resolve(id,importer,aliasOnly,ssr)
          if(resolved||aliasOnly)return resolved
          const from=importer?.startsWith('/app/')?importer:'/app/__virtual__.js'
          return resolveVolumeImport(id,from,ssr?'server':'client')
        }
      }
      Object.defineProperty(config,'createResolver',{value:createWorkspaceResolver,writable:true,configurable:true})
    },
    load(id){
      if(/[?&]url(?:[&=]|$)/.test(id))return
      const path=id.split('?')[0]
      if(!isContainerModulePath(path)||!/\.(?:[cm]?[jt]sx?|json|css|astro)$/.test(path)||!statSync(path,{throwIfNoEntry:false})?.isFile())return
      return readFileSync(path,'utf8') as string
    },
    async resolveId(id,importer,options){
      const conditions=new Set(this.environment?.config.consumer==='server'?serverConditions:clientConditions)
      for(const condition of this.environment?.config.resolve?.conditions??[])conditions.add(condition)
      const queryIndex=id.indexOf('?')
      const bareId=queryIndex<0?id:id.slice(0,queryIndex)
      const query=queryIndex<0?'':id.slice(queryIndex)
      if(bareId.startsWith('/@')||bareId.startsWith('\0'))return
      if(options.isEntry&&!importer){
        const entry=existingFile(normalize(join(this.environment?.config.root??'/app',bareId)))
        if(entry)return entry+query
      }
      let candidate:string
      if(isContainerModulePath(bareId))candidate=bareId
      else if(bareId.startsWith('/'))candidate=join('/app',bareId)
      else if(bareId.startsWith('node_modules/'))candidate=join('/app',bareId)
      else if(bareId.startsWith('.')&&importer&&isContainerModulePath(importer))candidate=join(dirname(importer),bareId)
      else if(!importer||isContainerModulePath(importer)||importer.startsWith('/@')||importer.startsWith('\0')){
        const packageImporter=importer&&isContainerModulePath(importer)?importer:'/app/__virtual__.js'
        if((this.environment?.config.resolve as {tsconfigPaths?:boolean}|undefined)?.tsconfigPaths){
          const mapped=resolveTsconfigPath(bareId)
          if(mapped)return mapped+query
        }
        if(bareId.startsWith('#')&&typeof this.resolve==='function'){
          const claimed=await this.resolve(id,importer,{skipSelf:true})
          if(claimed){
            if(this.environment?.config.consumer==='server'&&isBuiltin(claimed.id))
              return {...claimed,id:claimed.id.startsWith('node:')?claimed.id:`node:${claimed.id}`,external:true}
            return claimed
          }
        }
        const resolved=bareId.startsWith('#')?resolvePackageImport(bareId,packageImporter,conditions):
          resolveVolumeImport(bareId,packageImporter,this.environment?.config.consumer==='server'?'server':'client',conditions)
        if(resolved&&this.environment?.config.consumer==='server'&&isBuiltin(resolved))
          return {id:resolved+query,external:true}
        return resolved?resolved+query:undefined
      }
      else return
      candidate=normalize(candidate)
      if(!isContainerModulePath(candidate))return
      const resolved=existingFile(candidate)
      return resolved?resolved+query:undefined
    },
  }
}
