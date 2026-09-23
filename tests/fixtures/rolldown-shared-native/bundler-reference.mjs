import {t as bindingModule} from '../rolldown-native-probe/node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs'
import {t as createBundlerOptions} from '../rolldown-native-probe/node_modules/rolldown/dist/shared/create-bundler-option-DJpvtSqr.mjs'
import {snapshotBindingResult,encodeBindingSnapshot} from '../../../src/compiler/rolldown-binding-output.js'
import {readFileSync} from 'node:fs'
const project=process.argv[2],callbacks={}
let next=0
const encode=(value,key='')=>{
  if(typeof value==='function'){const id=++next;callbacks[id]=key;return {type:'guest-callback',id}}
  if(value instanceof RegExp)return {type:'RegExp',source:value.source,flags:value.flags}
  if(Array.isArray(value))return value.map(item=>encode(item))
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item,key)]))
  return value
}
const options=await createBundlerOptions({cwd:project,input:project+'/src/relative.js',plugins:[{name:'owned-shared-nested-resolver',async resolveId(){return null}}]},{format:'esm',dir:project+'/out',sourcemap:'hidden'},false)
const encoded=encode(options.bundlerOptions),binding=bindingModule(),bundler=new binding.BindingBundler()
binding.startAsyncRuntime()
try{
  const result=await bundler.write(options.bundlerOptions),snapshot=snapshotBindingResult(result)
  const files=Object.fromEntries([...snapshot.chunks.flatMap(chunk=>[chunk.getFileName,...chunk.getSourcemapFileName?[chunk.getSourcemapFileName]:[]]),...snapshot.assets.map(asset=>asset.getFileName)].map(name=>[name,Array.from(readFileSync(project+'/out/'+name))]))
  console.log(JSON.stringify({options:encoded,callbacks,result:encodeBindingSnapshot(snapshot),files}))
}finally{await bundler.close();binding.shutdownAsyncRuntime()}
