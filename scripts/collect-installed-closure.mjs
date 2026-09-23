import {lstat,readdir,readFile} from 'node:fs/promises'
import path from 'node:path'

// Preserve npm's installed nesting. Copy complete package contents because
// compilers and frameworks load files that no static import graph can discover.
export async function collectInstalledClosure(root,seeds){
  const files={},packages=[],missingOptional=[]
  const visited=new Set()
  const resolvePackage=async(name,from)=>{
    for(let directory=from;directory===root||directory.startsWith(root+path.sep);directory=path.dirname(directory)){
      const candidate=path.join(directory,'node_modules',name)
      try{await lstat(path.join(candidate,'package.json'));return candidate}catch(error){if(error.code!=='ENOENT')throw error}
    }
  }
  const copy=async(directory)=>{
    for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
      if(entry.name==='node_modules')continue
      const file=path.join(directory,entry.name)
      if(entry.isSymbolicLink())throw Error('Installed package contains a symlink: '+file)
      if(entry.isDirectory())await copy(file)
      else if(entry.isFile())files['/'+path.relative(root,file).split(path.sep).join('/')]={base64:(await readFile(file)).toString('base64')}
      else throw Error('Unsupported installed package entry: '+file)
    }
  }
  const visit=async(name,from,optional=false)=>{
    const directory=await resolvePackage(name,from)
    if(!directory){
      if(optional){missingOptional.push({name,from:'/'+path.relative(root,from).split(path.sep).join('/')});return}
      throw Error('Missing installed dependency '+name+' from '+from)
    }
    if(visited.has(directory))return
    if((await lstat(directory)).isSymbolicLink())throw Error('Installed package is a symlink: '+directory)
    visited.add(directory)
    const manifest=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'))
    packages.push({name:manifest.name,version:manifest.version,path:'/'+path.relative(root,directory).split(path.sep).join('/')})
    await copy(directory)
    const names=new Set([...Object.keys(manifest.dependencies??{}),...Object.keys(manifest.optionalDependencies??{}),...Object.keys(manifest.peerDependencies??{})])
    for(const dependency of [...names].sort())await visit(dependency,directory,
      Object.hasOwn(manifest.optionalDependencies??{},dependency)||Boolean(manifest.peerDependenciesMeta?.[dependency]?.optional))
  }
  for(const seed of seeds)await visit(seed,root)
  return {files,preparation:{kind:'installed-dependency-closure',packages:packages.sort((a,b)=>a.path.localeCompare(b.path,'en')),missingOptional,
    nativeAssets:Object.keys(files).filter(file=>file.endsWith('.node')).sort(),
    scope:'Complete locally installed package files, including metadata and binary assets. No browser package installation or native addon execution is implied.'}}
}
