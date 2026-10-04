interface ResolvedId{id:string}
import {lightningcssPackageRoot} from './browser-lightningcss'
import {oxidePackageRoot} from './browser-oxide'
import {esbuildPackageRoot} from './browser-esbuild'
import {isBuiltin} from '../vite-browser/node-module'
import {isContainerModulePath} from './volume-resolver'
import {dataModuleURL,dataModuleSource} from './data-module'
import {transformNativeAsyncContext} from './async-context-transform'
const rolldownEntries:Record<string,string>={
  'rolldown':'index.mjs',
  'rolldown/parseAst':'parse-ast-index.mjs',
  'rolldown/plugins':'plugins-index.mjs',
  'rolldown/experimental':'experimental-index.mjs',
  'rolldown/utils':'utils-index.mjs',
  'rolldown/filter':'filter-index.mjs',
  'rolldown/getLogFilter':'get-log-filter.mjs',
  'rolldown/config':'config.mjs',
  'rolldown/parallelPlugin':'parallel-plugin.mjs',
}
function rolldownEntry(id:string):string|undefined{
  if(id in rolldownEntries)return id
  const match=/^\/(?:app\/)?node_modules\/rolldown\/dist\/([^/?]+)$/.exec(id)
  if(!match)return
  return Object.keys(rolldownEntries).find(key=>rolldownEntries[key]===match[1])
}
function prettierPackageRoot(id:string):string|undefined{
  const match=/^(.*\/node_modules\/prettier)\/index\.mjs$/.exec(id)
  return match&&isContainerModulePath(match[1]+'/')?match[1]:undefined
}
interface RunnableEnvironment{
  runner?:{import(id:string):Promise<unknown>;evaluator?:{runExternalModule?:(file:string)=>Promise<unknown>;setDataModuleImporter?:(importer:(id:string)=>Promise<unknown>)=>void}}
  pluginContainer:{resolveId(id:string,importer?:string):Promise<ResolvedId|null>}
  fetchModule(id:string,importer?:string,options?:unknown):Promise<unknown>
}

/** Route installed project imports through Vite's worker-owned transform pipeline. */
export function installBrowserModuleFetch(environment:RunnableEnvironment,onActivity?:(phase:'start'|'end',id:string,handle:object)=>void):void{
  environment.runner?.evaluator?.setDataModuleImporter?.(id=>environment.runner!.import(id))
  const fetchModule=environment.fetchModule.bind(environment)
  environment.fetchModule=async(id,importer,options)=>{
    const handle={}
    onActivity?.('start',id,handle)
    try{
      const dataURL=dataModuleURL(id)
      if(dataURL){
        const source=dataModuleSource(dataURL)
        const lowered=await transformNativeAsyncContext(source,id)
        const {moduleRunnerTransform}=await import('vite')
        const transformed=await moduleRunnerTransform(lowered?.code??source,lowered?.map??null,id,source)
        return {...transformed,id,url:id,file:id}
      }
      const builtinId=id.startsWith('/@id/')?id.slice('/@id/'.length):id
      if(isBuiltin(builtinId))return {externalize:builtinId.startsWith('node:')?builtinId:`node:${builtinId}`,type:'builtin'}
      if(id==='lightningcss'){
        const resolved=await environment.pluginContainer.resolveId(id,importer)
        const packageRoot=resolved&&lightningcssPackageRoot(resolved.id)
        if(packageRoot)return {externalize:`browser-native:lightningcss:${encodeURIComponent(packageRoot)}`,type:'builtin'}
      }
      const lightningcssRoot=lightningcssPackageRoot(id)
      if(lightningcssRoot&&/\/node\/index\.(?:js|mjs)$/.test(id)){
        return {externalize:`browser-native:lightningcss:${encodeURIComponent(lightningcssRoot)}`,type:'builtin'}
      }
      if(id==='@tailwindcss/oxide'){
        const resolved=await environment.pluginContainer.resolveId(id,importer)
        const packageRoot=resolved&&oxidePackageRoot(resolved.id)
        if(packageRoot)return {externalize:`browser-native:oxide:${encodeURIComponent(packageRoot)}`,type:'builtin'}
      }
      const oxideRoot=oxidePackageRoot(id)
      if(oxideRoot&&id.endsWith('/index.js')){
        return {externalize:`browser-native:oxide:${encodeURIComponent(oxideRoot)}`,type:'builtin'}
      }
      if(id==='prettier'){
        const resolved=await environment.pluginContainer.resolveId(id,importer)
        const root=resolved&&prettierPackageRoot(resolved.id)
        if(root)return {externalize:`browser-native:prettier:${encodeURIComponent(root)}`,type:'builtin'}
        return {externalize:'browser-native:prettier',type:'builtin'}
      }
      const prettierRoot=prettierPackageRoot(id.startsWith('/@fs/')?id.slice('/@fs'.length):id)
      if(prettierRoot)return {externalize:`browser-native:prettier:${encodeURIComponent(prettierRoot)}`,type:'builtin'}
      if(id==='esbuild'){
        const resolved=await environment.pluginContainer.resolveId(id,importer)
        if(resolved&&esbuildPackageRoot(resolved.id))return {externalize:`browser-native:esbuild:${encodeURIComponent(esbuildPackageRoot(resolved.id)!)}`,type:'builtin'}
      }
      const esbuildRoot=esbuildPackageRoot(id)
      if(esbuildRoot&&/\/lib\/main\.js$/.test(id))
        return {externalize:`browser-native:esbuild:${encodeURIComponent(esbuildRoot)}`,type:'builtin'}
      if(id==='vite'||/^\/(?:app\/)?node_modules\/vite\/dist\/node\/index\.js$/.test(id)){
        return {externalize:'browser-native:vite',type:'builtin'}
      }
      const browserRolldownEntry=rolldownEntry(id)
      if(browserRolldownEntry){
        return {externalize:`browser-native:${browserRolldownEntry}`,type:'builtin'}
      }
      if(importer&&isContainerModulePath(importer)&&!id.startsWith('.')&&!id.startsWith('/')&&!id.startsWith('node:')&&!id.startsWith('data:')&&!id.includes(':')){
        const resolved=await environment.pluginContainer.resolveId(id,importer)
        if(resolved&&isBuiltin(resolved.id))return {externalize:resolved.id.startsWith('node:')?resolved.id:`node:${resolved.id}`,type:'builtin'}
        if(resolved&&isContainerModulePath(resolved.id))return await fetchModule(resolved.id,importer,options)
      }
      return await fetchModule(id,importer,options)
    }finally{onActivity?.('end',id,handle)}
  }
}
