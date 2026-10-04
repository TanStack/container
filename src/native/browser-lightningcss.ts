import * as lightningcss132 from 'lightningcss-wasm-132'
import * as lightningcss133 from 'lightningcss-wasm'
import {readFileSync} from '../vite-browser/node-fs'

type LightningcssModule=typeof lightningcss132|typeof lightningcss133
const bindings:Record<string,{module:LightningcssModule;wasm:string}>={
  '1.32.0':{module:lightningcss132,wasm:new URL('./lightningcss-1.32.0.wasm',import.meta.url).href},
  '1.33.0':{module:lightningcss133,wasm:new URL('./lightningcss_node.wasm',import.meta.url).href},
}
const prepared=new Set<string>()

export function lightningcssPackageRoot(path:string):string|undefined{
  const marker='/node_modules/lightningcss/'
  const index=path.lastIndexOf(marker)
  if(index<0)return
  const root=path.slice(0,index+marker.length-1)
  return root.startsWith('/node_modules/')?`/app${root}`:root
}

export function lightningcssVersion(packageRoot:string):string{
  const manifest=JSON.parse(readFileSync(`${packageRoot}/package.json`,'utf8') as string) as {name?:string;version?:string}
  if(manifest.name!=='lightningcss'||!manifest.version)throw Error(`Invalid Lightning CSS package at ${packageRoot}`)
  return manifest.version
}

export async function prepareLightningcss(packageRoots:string[]):Promise<void>{
  const versions=new Set(packageRoots
    .filter(root=>root.endsWith('/node_modules/lightningcss'))
    .map(lightningcssVersion))
  for(const version of versions){
    const binding=bindings[version]
    if(!binding)throw Error(`Browser Lightning CSS binding is unavailable for installed version ${version}`)
    if(prepared.has(version))continue
    await binding.module.default(binding.wasm)
    prepared.add(version)
  }
}

export function preparedLightningcss(packageRoot:string):LightningcssModule{
  const version=lightningcssVersion(packageRoot)
  const binding=bindings[version]
  if(!binding)throw Error(`Browser Lightning CSS binding is unavailable for installed version ${version}`)
  if(!prepared.has(version))throw Error(`Browser Lightning CSS ${version} was not initialized`)
  return binding.module
}
