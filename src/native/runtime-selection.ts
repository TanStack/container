import type {RuntimeLock} from '../npm/types'
export interface NativeRuntimeCandidate{
  workerURL:string|URL
  toolchain:{vite:string;rolldown:string}
}
export function selectNativeRuntime(files:Record<string,string|Uint8Array>,candidates:readonly NativeRuntimeCandidate[],lock?:RuntimeLock,installedOnly=false){
  const read=(path:string)=>{
    const source=files[path]
    return source===undefined?undefined:JSON.parse(typeof source==='string'?source:new TextDecoder().decode(source))
  }
  const lockPath=files['/app/npm-shrinkwrap.json']!==undefined?'/app/npm-shrinkwrap.json':'/app/package-lock.json'
  const npmLock=lock||installedOnly?undefined:read(lockPath)
  if(npmLock!==undefined&&(!npmLock||typeof npmLock!=='object'||Array.isArray(npmLock)))
    throw Error('Invalid project lockfile: '+lockPath)
  const requirements:Record<string,string>={}
  for(const name of ['vite','rolldown']){
    const version=lock&&!installedOnly?lock.packages.find(pkg=>pkg.installPath==='/node_modules/'+name)?.version:
      npmLock?npmLock.packages?.['node_modules/'+name]?.version:read('/app/node_modules/'+name+'/package.json')?.version
    if(version!==undefined){
      if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))throw Error('Invalid installed compiler version for '+name)
      requirements[name]=version
    }
  }
  if(!Object.keys(requirements).length)throw Error('Runtime selection requires locked or mounted compiler versions')
  const matches=candidates.filter(candidate=>Object.entries(requirements).every(([name,version])=>candidate.toolchain[name as 'vite'|'rolldown']===version))
  if(matches.length!==1)throw Error(`Expected one matching native runtime for ${JSON.stringify(requirements)}, found ${matches.length}`)
  return matches[0]!
}
