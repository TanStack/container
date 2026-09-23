import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import {resolveSubpathImports} from '../rolldown-native-probe/resolve-callback.mjs'
const {t:loadBinding}=await import(pathToFileURL(resolve('fixtures/start-vite8-wasm/node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs')))
const restore=value=>{
  if(!value||typeof value!=='object')return value
  if(value.type==='RegExp')return new RegExp(value.source,value.flags)
  if(value.type==='callback')return undefined
  if(Array.isArray(value))return value.map(restore)
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,restore(item)]))
}
const descriptor=restore(JSON.parse(process.argv[2]))
descriptor.options.resolveSubpathImports=resolveSubpathImports
descriptor.options.onWarn=()=>{}
const binding=loadBinding(),plugin=new binding.BindingCallableBuiltinPlugin(descriptor)
const id=process.argv[3]
try{
  const load=await plugin.load(id),transform=await plugin.transform('export const answer = 42',id,{moduleType:'js'})
  console.log(JSON.stringify({load:load===undefined?{kind:'undefined'}:{kind:'value',value:load},transform:transform===undefined?{kind:'undefined'}:{kind:'value',value:transform}}))
}finally{await binding.shutdownAsyncRuntime()}
