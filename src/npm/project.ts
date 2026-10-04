import {WorkspaceFiles} from '../sandbox/files'
import {traceInstallPhase} from './install-phase-trace'
import {processDirectory} from '../sandbox/process-directory'
import {installLockedPackages,inspectBundledPackages,PackageInstallCache} from './install'
import type {RuntimeLock,PackageIdentity} from './types'
import {minimatch} from 'minimatch'
import {maxSatisfying,satisfies,validRange} from 'semver'

export interface ProjectInstallOptions {ignoreScripts?:boolean;cwd?:string}
export interface ProjectInstallResult {installed:number;skippedPlatformPackages:string[];ignoredScripts:string[];packageAliases?:{installPath:string;name:string;version:string}[]}
export type PackageLifecycleEvent='preinstall'|'install'|'postinstall'|'prepublish'|'preprepare'|'prepare'|'postprepare'
export interface PackageLifecycleTask {cwd:string;event:PackageLifecycleEvent;script:string;env:Record<string,string>}
type RecordValue=Record<string,unknown>
function record(value:unknown,label:string):RecordValue {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid '+label)
  return value as RecordValue
}
const namePattern=/^(?:@[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*$/
const browserPortablePlatform=(pkg:RecordValue)=>pkg.os===undefined&&pkg.libc===undefined&&Array.isArray(pkg.cpu)&&pkg.cpu.length===1&&pkg.cpu[0]==='wasm32'
function packagePath(path:string){
  if(!path.startsWith('node_modules/')||!path.split('node_modules/').slice(1).every((part,index,all)=>{
    const name=index===all.length-1?part:part.slice(0,-1)
    return namePattern.test(name)&&(index===all.length-1||part.endsWith('/'))
  }))throw Error('Invalid package install path: '+path)
  return '/'+path
}
function dependencies(value:unknown):Record<string,string>{
  if(value===undefined)return {}
  const result=record(value,'dependencies')
  for(const [name,spec] of Object.entries(result))if(!namePattern.test(name)||typeof spec!=='string')throw Error('Invalid dependency: '+name)
  return result as Record<string,string>
}
function unsupported(message:string):Error&{code:string}{return Object.assign(Error(message),{code:'ERR_UNSUPPORTED_OPERATION'})}
function semverRange(spec:string,label:string){
  const range=validRange(spec)
  if(!range)throw unsupported('Unsupported non-semver '+label+': '+spec)
  return range
}
function registrySpec(name:string,spec:string){
  if(!spec.startsWith('npm:')){
    const range=validRange(spec)
    if(!range)throw unsupported('Lockless dependency spec is unsupported for '+name+': '+spec)
    return {name,range}
  }
  const alias=spec.slice(4),at=alias.lastIndexOf('@')
  if(at<=0)throw unsupported('Unsupported npm alias for '+name+': '+spec)
  const target=alias.slice(0,at)
  if(!namePattern.test(target))throw unsupported('Unsupported npm alias for '+name+': '+spec)
  return {name:target,range:semverRange(alias.slice(at+1),'npm alias for '+name)}
}
function bundledNames(pkg:RecordValue,regular:Record<string,string>,optional:Record<string,string>){
  const declaration=pkg.bundleDependencies??pkg.bundledDependencies
  if(declaration===undefined||declaration===false)return []
  const names=declaration===true?Object.keys({...regular,...optional}):declaration
  if(!Array.isArray(names)||names.some(name=>typeof name!=='string'||!namePattern.test(name)))
    throw Error('Invalid bundled dependency declaration')
  return [...new Set(names as string[])]
}
function topLevelBundleName(path:string){
  const parts=path.slice('node_modules/'.length).split('/')
  return parts[0]?.startsWith('@')?parts.slice(0,2).join('/'):parts[0]
}
function localPath(path:string){
  if(!path||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'||part==='node_modules')||path.includes(':'))throw Error('Invalid local package path: '+path)
  return '/'+path
}
function workspacePatterns(value:unknown):string[]{
  if(value===undefined)return []
  const patterns=Array.isArray(value)?value:record(value,'workspaces').packages
  if(!Array.isArray(patterns)||patterns.some(pattern=>typeof pattern!=='string'||!pattern))throw Error('Invalid workspace patterns')
  return patterns
}
function workspacePatternMatches(path:string,patterns:string[]){
  let matched=false
  for(const input of patterns){
    const bangs=input.match(/^!+/)?.[0].length??0
    const pattern=input.slice(bangs).replace(/^\.?\/+/, '').replace(/\\/g,'/').replace(/\/+$/,'')
    if(minimatch(path,pattern))matched=bangs%2===0
  }
  return matched
}
function registryMetadataURL(name:string){return 'https://registry.npmjs.org/'+(name.startsWith('@')?name.replace('/','%2f'):name)}
async function fetchRegistryMetadata(name:string,signal?:AbortSignal){
  const url=registryMetadataURL(name)
  for(let attempt=0;attempt<3;attempt++){
    signal?.throwIfAborted()
    let response:Response|undefined
    try{
      response=await fetch(url,{signal,headers:{accept:'application/vnd.npm.install-v1+json'}})
    }catch(error){
      if(signal?.aborted)throw error
      if(attempt===2||!(error instanceof TypeError))throw error
    }
    if(response?.ok)return response
    if(response&&((response.status!==429&&response.status<500)||attempt===2))
      throw Error('Registry metadata request failed for '+name+': '+response.status)
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},100*(attempt+1))
      const abort=()=>{clearTimeout(timer);reject(signal?.reason??new DOMException('Aborted','AbortError'))}
      signal?.addEventListener('abort',abort,{once:true})
      if(signal?.aborted)abort()
    })
  }
  throw Error('Registry metadata request failed for '+name)
}
const maxLocklessDirectDependencies=128,maxLocklessPackages=512,maxLocklessMetadataPackages=256,maxRegistryMetadataBytes=16*1024*1024,maxRegistryMetadataTotalBytes=96*1024*1024
/** Resolve a deterministic bounded npm v3 physical tree from registry metadata. */
export async function resolveProjectLock(manifestText:string,signal?:AbortSignal,cache?:PackageInstallCache,onActivity?:()=>void){
  await cache?.ready(signal)
  onActivity?.()
  const manifest=record(JSON.parse(manifestText),'package.json')
  if(workspacePatterns(manifest.workspaces).length)throw unsupported('Lockless workspace installs are unsupported; generate package-lock.json with npm first')
  const requested={...dependencies(manifest.dependencies),...dependencies(manifest.devDependencies),...dependencies(manifest.optionalDependencies)}
  if(Object.keys(requested).length>maxLocklessDirectDependencies)throw unsupported('Lockless installs support at most '+maxLocklessDirectDependencies+' direct dependencies')
  const packages:Record<string,unknown>={'':structuredClone(manifest)}
  const preferredRoots=new Map<string,{name:string;version:string}>()
  const metadataCache=new Map<string,RecordValue>()
  let metadataBytes=0
  const metadataFor=async(name:string)=>{
    const cached=metadataCache.get(name)
    if(cached)return cached
    if(metadataCache.size>=maxLocklessMetadataPackages)throw unsupported('Lockless installs support metadata for at most '+maxLocklessMetadataPackages+' package names')
    signal?.throwIfAborted()
    const cachedText=cache?.getMetadata(name)
    if(cachedText){
      try{const metadata=record(JSON.parse(cachedText),'cached registry metadata for '+name);metadataCache.set(name,metadata);onActivity?.();return metadata}
      catch{cache?.deleteMetadata(name)}
    }
    const response=await fetchRegistryMetadata(name,signal)
    const declared=Number(response.headers.get('content-length'))
    if(Number.isFinite(declared)&&declared>maxRegistryMetadataBytes)throw Error('Registry metadata exceeds '+maxRegistryMetadataBytes+' bytes for '+name)
    const metadataText=await response.text()
    onActivity?.()
    const bytes=new TextEncoder().encode(metadataText).length
    if(bytes>maxRegistryMetadataBytes)throw Error('Registry metadata exceeds '+maxRegistryMetadataBytes+' bytes for '+name)
    metadataBytes+=bytes
    if(metadataBytes>maxRegistryMetadataTotalBytes)throw unsupported('Lockless registry metadata exceeds '+maxRegistryMetadataTotalBytes+' total bytes')
    const metadata=record(JSON.parse(metadataText),'registry metadata for '+name)
    cache?.putMetadata(name,metadataText,bytes)
    metadataCache.set(name,metadata)
    return metadata
  }
  const parentScope=(path:string)=>{
    const marker=path.lastIndexOf('/node_modules/')
    return marker<0?'':path.slice(0,marker)
  }
  const ancestors=(parent:string,name:string)=>{
    const result:string[]=[]
    for(let scope=parent;;){
      result.push((scope?scope+'/':'')+'node_modules/'+name)
      if(!scope)break
      scope=parentScope(scope)
    }
    return result
  }
  const installEdge=async(parent:string,name:string,spec:string,ancestry:Set<string>,optional=false,peer=false):Promise<string|undefined>=>{
    const {name:packageName,range}=registrySpec(name,spec)
    for(const candidate of ancestors(parent,name)){
      const existing=packages[candidate] as RecordValue|undefined
      if(existing&&existing.name===packageName&&typeof existing.version==='string'&&satisfies(existing.version,range))return candidate
    }
    const rootPath='node_modules/'+name
    const preferred=preferredRoots.get(name)
    const reservedForOtherVersion=preferred?.name===packageName&&!satisfies(preferred.version,range)
    let path=packages[rootPath]===undefined&&!reservedForOtherVersion?rootPath:(parent?parent+'/node_modules/'+name:rootPath)
    if(packages[path]!==undefined){
      if(peer)throw Error('Lockless peer dependency conflict for '+name+'@'+spec)
      throw Error('Lockless dependency conflict for '+name+'@'+spec+' required by '+(parent||'/'))
    }
    const before=optional?structuredClone(packages):undefined
    try{
      const metadata=await metadataFor(packageName),versions=record(metadata.versions,'registry versions for '+packageName)
      const version=path===rootPath&&preferred?.name===packageName&&satisfies(preferred.version,range)
        ?preferred.version:maxSatisfying(Object.keys(versions),range)
      if(!version)throw Error('No registry version of '+packageName+' satisfies '+spec)
      const identity=packageName+'@'+version
      if(ancestry.has(identity))throw Error('Lockless dependency cycle includes '+[...ancestry,identity].join(' -> '))
      const selected=record(versions[version],'registry version '+packageName+'@'+version),dist=record(selected.dist,'registry distribution '+packageName+'@'+version)
      if(selected.name!==packageName||selected.version!==version)throw Error('Registry package identity does not match '+packageName+'@'+version)
      if(typeof dist.tarball!=='string'||typeof dist.integrity!=='string')throw Error('Registry package requires a tarball and integrity: '+packageName+'@'+version)
      if(optional&&(selected.os||selected.cpu||selected.libc)&&!browserPortablePlatform(selected))return undefined
      if(Object.keys(packages).length-1>=maxLocklessPackages)throw unsupported('Lockless installs support at most '+maxLocklessPackages+' physical packages')
      const regular=dependencies(selected.dependencies),optionalDependencies=dependencies(selected.optionalDependencies)
      const peers=dependencies(selected.peerDependencies),peerMeta=selected.peerDependenciesMeta===undefined?{}:record(selected.peerDependenciesMeta,'peerDependenciesMeta')
      const declaredBundles=bundledNames(selected,regular,optionalDependencies)
      packages[path]={name:packageName,version,resolved:dist.tarball,integrity:dist.integrity,dependencies:regular,optionalDependencies,
        ...(declaredBundles.length?{bundleDependencies:declaredBundles}:{}),
        ...(Object.keys(peers).length?{peerDependencies:peers}:{}),...(Object.keys(peerMeta).length?{peerDependenciesMeta:peerMeta}:{}),
        ...(optional?{optional:true}:{}),...(selected.bin===undefined?{}:{bin:selected.bin}),...(selected.os===undefined?{}:{os:selected.os}),
        ...(selected.cpu===undefined?{}:{cpu:selected.cpu}),...(selected.libc===undefined?{}:{libc:selected.libc}),
        ...(selected.scripts===undefined?{}:{scripts:selected.scripts}),...(selected.hasInstallScript===undefined?{}:{hasInstallScript:selected.hasInstallScript})}
      const bundledPaths:string[]=[]
      if(declaredBundles.length){
        const archives=await inspectBundledPackages(dist.tarball,dist.integrity,cache,signal,onActivity)
        const declared=new Set(declaredBundles),found=new Set<string>()
        for(const bundled of archives){
          const top=topLevelBundleName(bundled.path)
          if(!top||!declared.has(top))throw Error('Archive contains an undeclared bundled package: '+bundled.path)
          if(bundled.path==='node_modules/'+top)found.add(top)
          const bundledPath=path+'/'+bundled.path,manifest=bundled.manifest
          packagePath(bundledPath)
          if(typeof manifest.name!=='string'||!namePattern.test(manifest.name)||typeof manifest.version!=='string')
            throw Error('Invalid bundled package identity: '+bundled.path)
          if(packages[bundledPath]!==undefined)throw Error('Duplicate bundled package: '+bundled.path)
          if(Object.keys(packages).length-1>=maxLocklessPackages)throw unsupported('Lockless installs support at most '+maxLocklessPackages+' physical packages')
          packages[bundledPath]={name:manifest.name,version:manifest.version,inBundle:true,
            dependencies:dependencies(manifest.dependencies),optionalDependencies:dependencies(manifest.optionalDependencies),
            ...(optional?{optional:true}:{}),...(manifest.peerDependencies===undefined?{}:{peerDependencies:dependencies(manifest.peerDependencies)}),
            ...(manifest.peerDependenciesMeta===undefined?{}:{peerDependenciesMeta:record(manifest.peerDependenciesMeta,'bundled peer metadata')}),
            ...(manifest.os===undefined?{}:{os:manifest.os}),...(manifest.cpu===undefined?{}:{cpu:manifest.cpu}),
            ...(manifest.libc===undefined?{}:{libc:manifest.libc})}
          bundledPaths.push(bundledPath)
        }
        for(const bundled of declared)if(!found.has(bundled))throw Error('Declared bundled dependency is missing from archive: '+bundled)
      }
      const next=new Set(ancestry).add(identity),scope=parentScope(path)
      for(const peerName of Object.keys(peers).sort()){
        const meta=peerMeta[peerName]===undefined?{}:record(peerMeta[peerName],'peer dependency metadata')
        if(meta.optional===true)continue
        await installEdge(scope,peerName,peers[peerName],next,false,true)
      }
      for(const dependency of Object.keys(regular).sort()){
        if(Object.hasOwn(optionalDependencies,dependency))continue
        await installEdge(path,dependency,regular[dependency],next)
      }
      for(const dependency of Object.keys(optionalDependencies).sort())await installEdge(path,dependency,optionalDependencies[dependency],next,true)
      for(const bundledPath of bundledPaths){
        const manifest=packages[bundledPath] as RecordValue
        const bundledIdentity=new Set(next).add(String(manifest.name)+'@'+manifest.version)
        const regular=dependencies(manifest.dependencies),optional=dependencies(manifest.optionalDependencies)
        for(const dependency of Object.keys(regular).sort()){
          if(Object.hasOwn(optional,dependency))continue
          await installEdge(bundledPath,dependency,regular[dependency],bundledIdentity)
        }
        for(const dependency of Object.keys(optional).sort())await installEdge(bundledPath,dependency,optional[dependency],bundledIdentity,true)
      }
      return path
    }catch(error){
      if(!optional)throw error
      for(const key of Object.keys(packages))delete packages[key]
      Object.assign(packages,before)
      return undefined
    }
  }
  const rootOptional=dependencies(manifest.optionalDependencies)
  for(const name of Object.keys(requested).sort()){
    await installEdge('',name,requested[name],new Set(),Object.hasOwn(rootOptional,name))
  }
  // Discover the complete graph before choosing shared root versions. A deep
  // dependency visited first must not reserve an old root copy and force every
  // newer consumer into a different module instance. Direct constraints win.
  for(const [path,value] of Object.entries(packages)){
    if(!path)continue
    const entry=value as RecordValue
    if(entry.inBundle||typeof entry.name!=='string'||typeof entry.version!=='string')continue
    const name=path.slice(path.lastIndexOf('node_modules/')+'node_modules/'.length)
    const direct=requested[name]===undefined?undefined:registrySpec(name,requested[name])
    if(direct&&(direct.name!==entry.name||!satisfies(entry.version,direct.range)))continue
    const previous=preferredRoots.get(name)
    if(previous&&previous.name!==entry.name)continue
    const version=maxSatisfying([entry.version,...(previous?[previous.version]:[])],'*')
    if(version)preferredRoots.set(name,{name:entry.name,version})
  }
  for(const path of Object.keys(packages))if(path)delete packages[path]
  for(const name of Object.keys(requested).sort()){
    await installEdge('',name,requested[name],new Set(),Object.hasOwn(rootOptional,name))
  }
  await cache?.flush(signal)
  return JSON.stringify({name:manifest.name,version:manifest.version,lockfileVersion:3,packages})
}
function discoverWorkspaces(files:WorkspaceFiles,root:string,patterns:string[]){
  const includes:string[]=[],excludes:string[]=[]
  for(const input of patterns){
    const bangs=input.match(/^!+/)?.[0].length??0
    const pattern=input.slice(bangs).replace(/^\.?\/+/, '').replace(/\\/g,'/').replace(/\/+$/,'')
    if(pattern.split('/').includes('..'))throw Error('Workspace pattern leaves project: '+input)
    if(bangs%2)excludes.push(pattern)
    else{
      for(let i=excludes.length-1;i>=0;i--)if(minimatch(pattern,excludes[i]))excludes.splice(i,1)
      includes.push(pattern)
    }
  }
  const matches=(path:string)=>includes.some(pattern=>minimatch(path,pattern))&&!excludes.some(pattern=>minimatch(path,pattern))
  const result:string[]=[],pending=['']
  for(let i=0;i<pending.length;i++){
    const relative=pending[i],absolute=root+(relative?'/'+relative:'')
    for(const entry of files.readdirSync(absolute||'/')){
      if(entry.name==='node_modules')continue
      const path=relative?relative+'/'+entry.name:entry.name
      if(entry.kind==='symlink'){
        if(matches(path))throw Error('Workspace path must not contain symlinks: '+path)
        continue
      }
      if(entry.kind!=='directory')continue
      pending.push(path)
      if(matches(path)&&files.existsSync(root+'/'+path+'/package.json'))result.push('/'+path)
    }
  }
  return result
}

/** Read npm's physical package tree, without resolving new versions or running npm. */
export function planProjectInstall(manifestText:string,lockText:string,options:ProjectInstallOptions={}){
  const manifest=record(JSON.parse(manifestText),'package.json'),lock=record(JSON.parse(lockText),'lockfile')
  if(lock.lockfileVersion===1)throw unsupported('npm lockfile version 1 is unsupported because it does not contain the physical packages tree')
  if(lock.lockfileVersion!==2&&lock.lockfileVersion!==3)throw Error('Expected npm lockfile version 2 or 3')
  const packages=record(lock.packages,'lockfile packages'),root=record(packages[''],'lockfile root')
  if(JSON.stringify(workspacePatterns(manifest.workspaces))!==JSON.stringify(workspacePatterns(root.workspaces)))throw Error('Lockfile is out of sync with package.json: workspaces')
  for(const field of ['dependencies','devDependencies','optionalDependencies']){
    const actual=dependencies(manifest[field]),locked=dependencies(root[field])
    if(Object.keys(actual).length!==Object.keys(locked).length||Object.entries(actual).some(([key,value])=>locked[key]!==value))throw Error('Lockfile is out of sync with package.json: '+field)
  }
  const runtimeLock:RuntimeLock={version:1,packages:[]}
  const links:{installPath:string;target:string}[]=[]
  const locals:{installPath:string;name:string;version?:string}[]=[]
  for(const [path,value] of Object.entries(packages)){
    if(!path||path.includes('node_modules/'))continue
    const pkg=record(value,'local package')
    const link=Object.entries(packages).find(([,value])=>{const entry=record(value,'locked package');return entry.link===true&&entry.resolved===path})
    const name=pkg.name??link?.[0].slice(link[0].lastIndexOf('node_modules/')+13)
    if(!link||typeof name!=='string'||!namePattern.test(name)||(pkg.version!==undefined&&typeof pkg.version!=='string'))throw Error('Local package requires a link, name and an optional string version: '+path)
    locals.push({installPath:localPath(path),name,version:pkg.version})
  }
  const bundled:PackageIdentity[]=[]
  const result:ProjectInstallResult={installed:0,skippedPlatformPackages:[],ignoredScripts:[]}
  if(manifest.scripts){
    const scripts=record(manifest.scripts,'scripts')
    if(['preinstall','install','postinstall','prepare','prepublish','preprepare','postprepare'].some(name=>scripts[name]))result.ignoredScripts.push('/')
  }
  for(const [path,value] of Object.entries(packages)){
    if(path==='')continue
    if(locals.some(pkg=>pkg.installPath==='/'+path))continue
    const local=locals.find(pkg=>path.startsWith(pkg.installPath.slice(1)+'/node_modules/'))
    const installPath=local?local.installPath+packagePath(path.slice(local.installPath.length)):packagePath(path),pkg=record(value,'locked package')
    if(pkg.link){
      if(pkg.link!==true||typeof pkg.resolved!=='string'||!locals.some(local=>local.installPath===localPath(pkg.resolved as string)))throw Error('Invalid local package link: '+path)
      links.push({installPath,target:localPath(pkg.resolved)})
      continue
    }
    if((pkg.os||pkg.cpu||pkg.libc)&&!browserPortablePlatform(pkg)){
      if(pkg.optional===true){result.skippedPlatformPackages.push(installPath);continue}
      throw Error('Platform-specific package requires a browser implementation: '+path)
    }
    if(pkg.hasInstallScript)result.ignoredScripts.push(installPath)
    if(typeof pkg.version!=='string')throw Error('Package requires a version: '+path)
    const installedName=path.slice(path.lastIndexOf('node_modules/')+13)
    const name=pkg.name??installedName
    if(typeof name!=='string'||!namePattern.test(name))throw Error('Invalid locked package name: '+path)
    if(name!==installedName)(result.packageAliases??=[]).push({installPath,name,version:pkg.version})
    if(pkg.inBundle===true){bundled.push({installPath,name,version:pkg.version});continue}
    if(typeof pkg.resolved!=='string'||typeof pkg.integrity!=='string')throw Error('Package requires a version, registry URL and integrity: '+path)
    const url=new URL(pkg.resolved)
    if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.port||url.username||url.password||url.hash)throw Error('Package downloads are restricted to https://registry.npmjs.org')
    if(!/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity))throw Error('Package requires SHA-512 integrity: '+path)
    runtimeLock.packages.push({installPath,name,version:pkg.version,resolved:url.href,integrity:pkg.integrity})
  }
  // Bundled bytes come only from the closest enclosing downloaded package.
  // Lock entries still participate in dependency and installed-identity checks.
  for(const pkg of bundled){
    const owner=runtimeLock.packages.filter(parent=>pkg.installPath.startsWith(parent.installPath+'/node_modules/')).sort((a,b)=>b.installPath.length-a.installPath.length)[0]
    if(!owner)throw Error('Bundled package has no archive owner: '+pkg.installPath)
    ;(owner.bundledPackages??=[]).push(pkg)
  }
  const installed=new Set([...runtimeLock.packages,...bundled,...locals,...links].map(pkg=>pkg.installPath))
  const identities=new Map([...runtimeLock.packages,...bundled,...locals].map(pkg=>[pkg.installPath,pkg]))
  for(const link of links){
    const local=locals.find(pkg=>pkg.installPath===link.target)!
    identities.set(link.installPath,{...local,installPath:link.installPath})
  }
  const resolve=(path:string,name:string)=>{
    let scope=path
    while(true){
      const candidate='/'+(scope?scope+'/':'')+'node_modules/'+name
      if(installed.has(candidate))return identities.get(candidate)
      if(!scope)return undefined
      const parent=scope.lastIndexOf('/node_modules/')
      scope=parent<0?(scope.includes('/')?scope.slice(0,scope.lastIndexOf('/')):''):scope.slice(0,parent)
    }
  }
  const peerScope=(path:string)=>{
    const parent=path.lastIndexOf('/node_modules/')
    return parent<0?'':path.slice(0,parent)
  }
  // Reject incomplete trees rather than reporting success and failing on first import.
  for(const [path,value] of Object.entries(packages)){
    if(path&&!installed.has('/'+path))continue
    const pkg=record(value,'locked package'),required={...dependencies(pkg.dependencies),...(path===''||locals.some(pkg=>pkg.installPath==='/'+path)?dependencies(pkg.devDependencies):{})}
    const optional=dependencies(pkg.optionalDependencies)
    for(const name of Object.keys(required)){
      if(Object.hasOwn(optional,name))continue
      const resolved=resolve(path,name)
      if(!resolved)throw Error('Lockfile is missing dependency '+name+' required by '+(path||'/'))
      const spec=required[name],range=validRange(spec)
      if(range&&resolved.version&&!satisfies(resolved.version,range))throw Error('Lockfile dependency '+name+'@'+resolved.version+' does not satisfy '+spec+' required by '+(path||'/'))
    }
    const peers=dependencies(pkg.peerDependencies),metadata=pkg.peerDependenciesMeta===undefined?{}:record(pkg.peerDependenciesMeta,'peerDependenciesMeta')
    for(const [name,spec] of Object.entries(peers)){
      const meta=metadata[name]===undefined?{}:record(metadata[name],'peer dependency metadata')
      if(Object.keys(meta).some(key=>key!=='optional')||(meta.optional!==undefined&&typeof meta.optional!=='boolean'))throw Error('Invalid peer dependency metadata: '+name)
      const resolved=resolve(peerScope(path),name)
      if(!resolved){
        if(meta.optional===true)continue
        throw Error('Lockfile is missing peer dependency '+name+' required by '+(path||'/'))
      }
      const range=semverRange(spec,'peer dependency range for '+name)
      if((!resolved.version||!satisfies(resolved.version,range))&&meta.optional!==true)throw Error('Lockfile peer dependency '+name+'@'+(resolved.version??'unknown')+' does not satisfy '+spec+' required by '+(path||'/'))
    }
  }
  return {lock:runtimeLock,result,links,locals,packages,workspaces:workspacePatterns(manifest.workspaces)}
}

/** Stage in the worker, then commit only if no host or guest edit changed the live tree. */
const installCaches=new WeakMap<WorkspaceFiles,PackageInstallCache>()
function sameInstallTree(before:ReturnType<WorkspaceFiles['snapshot']>,after:ReturnType<WorkspaceFiles['snapshot']>){
  if(before.version!==5||after.version!==5)return false
  const sameEntries=(a:Record<string,unknown>,b:Record<string,unknown>)=>
    Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([key,value])=>b[key]===value)
  if(!sameEntries(before.fileModes,after.fileModes)||!sameEntries(before.directoryModes,after.directoryModes)||
    !sameEntries(before.symlinks,after.symlinks)||before.directories.length!==after.directories.length||
    before.directories.some(path=>!after.directories.includes(path)))return false
  return Object.keys(before.files).length===Object.keys(after.files).length&&
    Object.entries(before.files).every(([path,bytes])=>{
      const next=after.files[path]
      return next?.length===bytes.length&&bytes.every((byte,index)=>next[index]===byte)
    })
}
export async function installProject(files:WorkspaceFiles,options:ProjectInstallOptions={},signal?:AbortSignal,runLifecycle?:(task:PackageLifecycleTask)=>Promise<void>,onActivity?:()=>void):Promise<ProjectInstallResult>{
  signal?.throwIfAborted()
  const revision=files.revision
  const root=processDirectory(files,options.cwd??'/').replace(/\/$/,'')
  const staged=new WorkspaceFiles({},files.maxBytes,files.maxFiles)
  try{
  traceInstallPhase('workspace-staging',()=>staged.replace(files.snapshot()))
  // Planning belongs to the transaction too. Reading live manifests updates
  // their access times even when validation or a download later fails.
  const text=(path:string)=>new TextDecoder().decode(staged.readFileSync(path))
  const manifestText=text(root+'/package.json')
  const lockPath=staged.existsSync(root+'/npm-shrinkwrap.json')?root+'/npm-shrinkwrap.json':staged.existsSync(root+'/package-lock.json')?root+'/package-lock.json':''
  let cache=installCaches.get(files)
  if(!cache){cache=new PackageInstallCache();installCaches.set(files,cache)}
  const lockText=lockPath?text(lockPath):await resolveProjectLock(manifestText,signal,cache,onActivity)
  const plan=traceInstallPhase('install-planning',()=>planProjectInstall(manifestText,lockText,options))
  onActivity?.()
  const workspacePaths:string[]=[]
  if(plan.workspaces.length){
    const names=new Set<string>()
    for(const path of discoverWorkspaces(staged,root,plan.workspaces)){
      workspacePaths.push(path)
      const manifest=record(JSON.parse(text(root+path+'/package.json')),'workspace package.json')
      if(typeof manifest.name!=='string'||!namePattern.test(manifest.name))throw Error('Workspace requires a package name: '+path)
      if(names.has(manifest.name))throw Error('Duplicate workspace name: '+manifest.name)
      names.add(manifest.name)
      if(!plan.locals.some(local=>local.installPath===path&&local.name===manifest.name)||!plan.links.some(link=>link.installPath==='/node_modules/'+manifest.name&&link.target===path))throw Error('Workspace is missing from lockfile: '+path)
    }
    for(const local of plan.locals)if(workspacePatternMatches(local.installPath.slice(1),plan.workspaces)&&!workspacePaths.includes(local.installPath))throw Error('Locked workspace is missing from package.json workspaces: '+local.installPath)
  }
  const allPackages=plan.lock.packages.flatMap(pkg=>[pkg,...pkg.bundledPackages??[]])
  for(const pkg of allPackages)pkg.installPath=root+pkg.installPath
  plan.result.ignoredScripts=plan.result.ignoredScripts.map(path=>root+path)
  plan.result.skippedPlatformPackages=plan.result.skippedPlatformPackages.map(path=>root+path)
  for(const alias of plan.result.packageAliases??[])alias.installPath=root+alias.installPath
    const localManifests=new Map<string,RecordValue>()
    for(const local of plan.locals){
      const path=root+local.installPath
      if(staged.realpathSync(path)!==path)throw Error('Local package path must not contain symlinks: '+path)
      const manifest=record(JSON.parse(text(path+'/package.json')),'local package.json')
      localManifests.set(local.installPath,manifest)
      if(manifest.name!==local.name||manifest.version!==local.version)throw Error('Local package identity does not match lockfile: '+path)
      const locked=record(plan.packages[local.installPath.slice(1)],'local lock entry')
      for(const field of ['dependencies','devDependencies','optionalDependencies']){
        const actual=dependencies(manifest[field]),expected=dependencies(locked[field])
        if(Object.keys(actual).length!==Object.keys(expected).length||Object.entries(actual).some(([name,spec])=>expected[name]!==spec))throw Error('Local package lockfile is out of sync: '+path)
      }
      const scripts=manifest.scripts?record(manifest.scripts,'scripts'):{}
      if(['preinstall','install','postinstall','prepare','prepublish','preprepare','postprepare'].some(name=>scripts[name])||staged.existsSync(path+'/binding.gyp')){
        plan.result.ignoredScripts.push(path)
      }
      staged.rmSync(path+'/node_modules',{recursive:true,force:true})
    }
    const localByName=new Map(plan.locals.map(local=>[local.name,local]))
    const visiting=new Set<string>(),visited=new Set<string>(),orderedLocals:typeof plan.locals=[]
    const visitLocal=(local:(typeof plan.locals)[number])=>{
      if(visited.has(local.installPath))return
      if(visiting.has(local.installPath))throw Error('Workspace dependency cycle includes '+local.name)
      visiting.add(local.installPath)
      const manifest=localManifests.get(local.installPath)!,required={...dependencies(manifest.dependencies),...dependencies(manifest.devDependencies),...dependencies(manifest.optionalDependencies)}
      for(const [name,spec] of Object.entries(required)){
        const target=localByName.get(name)
        if(!target)continue
        if(!plan.links.some(link=>link.installPath==='/node_modules/'+name&&link.target===target.installPath))throw Error('Workspace dependency '+name+' is not linked to '+target.installPath)
        let range=spec
        if(spec.startsWith('workspace:')){
          const selector=spec.slice(10)
          if(selector==='*')range='*'
          else if(selector==='^'||selector==='~')range=selector+(target.version??'')
          else range=selector
        }
        const valid=validRange(range)
        if(!valid)throw unsupported('Unsupported workspace dependency range for '+name+': '+spec)
        if((!target.version&&range!=='*')||(target.version&&!satisfies(target.version,valid)))throw Error('Workspace dependency '+name+'@'+(target.version??'unknown')+' does not satisfy '+spec+' required by '+local.name)
        visitLocal(target)
      }
      visiting.delete(local.installPath);visited.add(local.installPath);orderedLocals.push(local)
    }
    for(const local of plan.locals)visitLocal(local)
    staged.rmSync(root+'/node_modules',{recursive:true,force:true})
    await installLockedPackages(staged,plan.lock,undefined,signal,cache,onActivity)
    for(const link of plan.links){
      const path=root+link.installPath
      staged.mkdirSync(path.slice(0,path.lastIndexOf('/')),true)
      staged.symlinkSync(root+link.target,path)
    }
    const linkedPackages=plan.links.map(link=>({...plan.locals.find(local=>local.installPath===link.target)!,installPath:root+link.installPath}))
    for(const pkg of [...allPackages,...linkedPackages]){
      const manifest=record(JSON.parse(new TextDecoder().decode(staged.readFileSync(pkg.installPath+'/package.json'))),'installed package.json')
      if(manifest.version!==pkg.version)throw Error('Package version does not match lockfile: '+pkg.installPath)
      if(manifest.name!==pkg.name)throw Error('Package name does not match lockfile: '+pkg.installPath)
      const scripts=manifest.scripts?record(manifest.scripts,'scripts'):{}
      if(['preinstall','install','postinstall'].some(name=>scripts[name])||staged.existsSync(pkg.installPath+'/binding.gyp')){
        if(!plan.result.ignoredScripts.includes(pkg.installPath))plan.result.ignoredScripts.push(pkg.installPath)
      }
      if(manifest.bin){
        const bins=typeof manifest.bin==='string'?{[pkg.installPath.split('/').pop()!]:manifest.bin}:record(manifest.bin,'bin')
        for(const [name,target] of Object.entries(bins)){
          if(!/^[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*$/.test(name)||typeof target!=='string'||!target||target.startsWith('/')||target.includes('\\')||target.split('/').includes('..'))throw Error('Invalid package executable: '+name)
          const path=pkg.installPath+'/'+target
          if(!staged.isFileSync(path))throw Error('Package executable is missing: '+path)
          staged.chmodSync(path,0o755)
          const parent=pkg.installPath.slice(0,pkg.installPath.lastIndexOf('/node_modules/')+14)
          staged.mkdirSync(parent+'.bin',true)
          const executable=parent+'.bin/'+name
          // npm keeps the first executable chosen for a node_modules level when
          // aliases or transitive packages expose the same bin name.
          if(!staged.entryExistsSync(executable))staged.symlinkSync(path,executable)
        }
      }
    }
    const lifecycle:PackageLifecycleTask[]=[]
    if(!options.ignoreScripts){
      const packageLocations=[...allPackages.map(pkg=>pkg.installPath),...orderedLocals.map(pkg=>root+pkg.installPath)].map(path=>staged.realpathSync(path))
      const locationSet=new Set(packageLocations),orderedLocations:string[]=[],ordering=new Set<string>(),ordered=new Set<string>()
      const resolveInstalled=(cwd:string,name:string)=>{
        for(let directory=cwd;;){
          const candidate=directory.replace(/\/$/,'')+'/node_modules/'+name
          if(staged.existsSync(candidate+'/package.json'))return staged.realpathSync(candidate)
          const marker=directory.lastIndexOf('/node_modules/')
          if(marker<0){
            const projectRoot=root||'/'
            if(directory!==projectRoot){directory=projectRoot;continue}
            return undefined
          }
          directory=directory.slice(0,marker)||'/'
        }
      }
      const orderLocation=(cwd:string)=>{
        if(ordered.has(cwd))return
        if(ordering.has(cwd))throw Error('Installed package lifecycle dependency cycle includes '+cwd)
        ordering.add(cwd)
        const manifest=record(JSON.parse(new TextDecoder().decode(staged.readFileSync(cwd+'/package.json'))),'installed package.json')
        const required={...dependencies(manifest.dependencies),...dependencies(manifest.optionalDependencies),...dependencies(manifest.peerDependencies)}
        for(const name of Object.keys(required).sort()){
          const target=resolveInstalled(cwd,name)
          if(target&&locationSet.has(target))orderLocation(target)
        }
        ordering.delete(cwd);ordered.add(cwd);orderedLocations.push(cwd)
      }
      for(const cwd of [...new Set(packageLocations)].sort())orderLocation(cwd)
      const localLocations=new Set(orderedLocals.map(pkg=>staged.realpathSync(root+pkg.installPath)))
      const unique=[...orderedLocations,root||'/']
      for(const cwd of unique){
        const manifestPath=(cwd==='/'?'':cwd)+'/package.json',manifest=record(JSON.parse(new TextDecoder().decode(staged.readFileSync(manifestPath))),'installed package.json')
        const scripts=manifest.scripts?record(manifest.scripts,'scripts'):{}
        if(staged.existsSync(cwd+'/binding.gyp')&&!scripts.install&&!scripts.preinstall)throw Object.assign(Error('Implicit node-gyp install scripts are unsupported'),{code:'ERR_UNSUPPORTED_OPERATION'})
        const paths:string[]=[]
        for(let directory=cwd;;directory=directory.slice(0,directory.lastIndexOf('/'))||'/'){
          paths.push(directory.replace(/\/$/,'')+'/node_modules/.bin')
          if(directory===root||directory==='/')break
        }
        paths.push('/usr/bin','/bin')
        const events:PackageLifecycleEvent[]=cwd===(root||'/')||localLocations.has(cwd)
          ?['preinstall','install','postinstall','prepublish','preprepare','prepare','postprepare']
          :['preinstall','install','postinstall']
        for(const event of events){
          const script=scripts[event]
          if(script===undefined)continue
          if(typeof script!=='string'||!script.trim())throw Error('Invalid package lifecycle script: '+event)
          lifecycle.push({cwd,event,script,env:{PATH:paths.join(':'),INIT_CWD:root||'/',npm_package_json:manifestPath,npm_lifecycle_event:event,npm_lifecycle_script:script,...(typeof manifest.name==='string'?{npm_package_name:manifest.name}:{}),...(typeof manifest.version==='string'?{npm_package_version:manifest.version}:{})}})
        }
      }
      if(lifecycle.length&&!runLifecycle)throw Object.assign(Error('Package lifecycle execution is unavailable in this installer'),{code:'ERR_UNSUPPORTED_OPERATION'})
    }
    signal?.throwIfAborted()
    const before=traceInstallPhase('workspace-commit',()=>{
      const previous=files.snapshot()
      const next=staged.snapshot()
      // A verified unchanged reinstall must not look like a filesystem edit.
      // The revision check still runs, and lifecycle writes remain observable.
      files.replace(sameInstallTree(previous,next)?previous:next,revision)
      return previous
    })
    try{for(const task of lifecycle){signal?.throwIfAborted();onActivity?.();await runLifecycle!(task);onActivity?.()}}catch(error){files.replace(before);throw error}
    if(!options.ignoreScripts)plan.result.ignoredScripts=[]
    return {...plan.result,installed:allPackages.length+plan.links.length}
  }finally{staged.close()}
}
