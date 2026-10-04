import {readFileSync} from '../vite-browser/node-fs'

const supportedVersion='4.3.3'
let binding:unknown
let disposeWorkers:(()=>void)|undefined

export function oxidePackageRoot(path:string):string|undefined{
  const marker='/node_modules/@tailwindcss/oxide/'
  const index=path.lastIndexOf(marker)
  if(index<0)return
  const root=path.slice(0,index+marker.length-1)
  return root.startsWith('/node_modules/')?`/app${root}`:root
}

export async function prepareOxide(packageRoots:string[]):Promise<void>{
  const packages=packageRoots.filter(root=>root.endsWith('/node_modules/@tailwindcss/oxide'))
  for(const root of packages){
    const manifest=JSON.parse(readFileSync(`${root}/package.json`,'utf8') as string) as {version?:string}
    if(manifest.version!==supportedVersion)throw Error(`Browser Tailwind Oxide binding is unavailable for installed version ${manifest.version}`)
  }
  if(!packages.length||binding)return
  const assetURL=new URL('./oxide/oxide.mjs',import.meta.url).href
  // The browser WASI binding chooses its worker protocol when evaluated.
  // The guest's Node version is a compatibility shim, not this worker's host.
  const versions=(globalThis as typeof globalThis&{process?:{versions?:Record<string,string|undefined>}}).process?.versions as Record<string,string|undefined>|undefined
  const nodeVersion=versions?.node
  try{
    if(versions)versions.node=undefined
    const module=await import(assetURL) as {default:Record<string,unknown>;disposeBrowserOxideWorkers:()=>void}
    binding=module.default
    disposeWorkers=module.disposeBrowserOxideWorkers
  }finally{
    if(versions&&nodeVersion!==undefined)versions.node=nodeVersion
  }
}

export function disposeOxideWorkers(){
  disposeWorkers?.()
  disposeWorkers=undefined
  binding=undefined
}

export function preparedOxide(packageRoot:string):unknown{
  const manifest=JSON.parse(readFileSync(`${packageRoot}/package.json`,'utf8') as string) as {name?:string;version?:string}
  if(manifest.name!=='@tailwindcss/oxide'||manifest.version!==supportedVersion)
    throw Error(`Browser Tailwind Oxide ${supportedVersion} does not match installed package at ${packageRoot}`)
  if(!binding)throw Error(`Browser Tailwind Oxide ${supportedVersion} was not initialized`)
  return binding
}
