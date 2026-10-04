import * as esbuild from 'esbuild-wasm'
import {readFileSync} from '../vite-browser/node-fs'

let initialized:Promise<void>|undefined

export async function initializeBrowserEsbuild(){
  initialized??=esbuild.initialize({wasmURL:new URL('./esbuild.wasm',import.meta.url).href,worker:false})
  await initialized
}

export function esbuildPackageRoot(path:string):string|undefined{
  const marker='/node_modules/esbuild/'
  const index=path.lastIndexOf(marker)
  if(index<0)return
  const root=path.slice(0,index+marker.length-1)
  return root.startsWith('/node_modules/')?`/app${root}`:root
}

export async function browserEsbuild(packageRoot:string):Promise<typeof esbuild>{
  const manifest=JSON.parse(readFileSync(`${packageRoot}/package.json`,'utf8') as string) as {name?:string;version?:string}
  if(manifest.name!=='esbuild'||manifest.version!==esbuild.version)
    throw Error(`Browser esbuild ${esbuild.version} does not match installed esbuild ${manifest.version??'unknown'}`)
  await initializeBrowserEsbuild()
  return esbuild
}
