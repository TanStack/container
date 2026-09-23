import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

const project=resolve(process.argv[2])
const shared=join(project,'node_modules/rolldown/dist/shared')
const {t:requireBinding}=await import(pathToFileURL(join(shared,'binding-BbrDfv1x.mjs')).href)
const {t:createBundlerOptions}=await import(pathToFileURL(join(shared,'create-bundler-option-DJpvtSqr.mjs')).href)
const binding=requireBinding()
const directory=mkdtempSync(join(tmpdir(),'rolldown-output-lifetime-'))
const describe=value=>value instanceof Error?{name:value.name,message:value.message,stack:value.stack,...value}:ArrayBuffer.isView(value)?{type:value.constructor.name,bytes:Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))}:value
const observe=fn=>{try{return {value:describe(fn())}}catch(error){return {error:describe(error)}}}
const records=[]
for(const invalid of [false,true,'plugin-error']){
  const bundle=new binding.BindingBundler();binding.startAsyncRuntime()
  try{
    const prepared=await createBundlerOptions({input:'owned-entry',plugins:[{
      name:'owned-output-lifetime',
      resolveId(id){if(id==='owned-entry')return '\0owned-entry'},
      load(id){if(id==='\0owned-entry'){if(invalid==='plugin-error')throw Object.assign(new Error('Owned plugin error'),{code:'OWNED_FAILURE'});return invalid?'export const =':'export const answer=42'}},
      buildStart(){if(!invalid)this.emitFile({type:'asset',fileName:'owned.bin',source:new Uint8Array([0,127,128,255])})},
    }]},{format:'esm',sourcemap:'hidden'},false)
    const output=await bundle.generate(prepared.bundlerOptions)
    if(invalid){records.push({invalid,output});continue}
    const chunk=output.chunks[0],asset=output.assets.find(value=>value.getFileName()==='owned.bin')
    const chunkGetters=['getCode','getFileName','getName','getExports','getModules','getImports','getMap']
    const modules=chunk.getModules()
    const before={chunk:Object.fromEntries(chunkGetters.map(name=>[name,observe(()=>chunk[name]())])),modules:{keys:modules.keys,values:modules.values.map(value=>({code:value.code,renderedExports:value.renderedExports}))},assetSource:describe(asset.getSource().inner)}
    const chunkDrop1=observe(()=>chunk.dropInner()),chunkDrop2=observe(()=>chunk.dropInner())
    const assetDrop1=observe(()=>asset.dropInner()),assetDrop2=observe(()=>asset.dropInner())
    const after={chunk:Object.fromEntries(chunkGetters.map(name=>[name,observe(()=>chunk[name]())])),assetSource:observe(()=>asset.getSource()),assetFileName:observe(()=>asset.getFileName())}
    records.push({invalid,before,chunkDrop1,chunkDrop2,assetDrop1,assetDrop2,after})
  }finally{await bundle.close();binding.shutdownAsyncRuntime()}
}
const evidence=JSON.stringify({project,directory,records},(_key,value)=>describe(value),2)
writeFileSync(join(directory,'evidence.json'),evidence)
console.log(evidence)
