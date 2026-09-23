import {readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {transformSync} from 'esbuild'

const directory=resolve(process.argv[2]??'public/quickjs-als-o2-vm-modules')
const loader=(await import(pathToFileURL(join(directory,'engine.mjs')).href)).default
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync(join(directory,'engine.wasm'))}))
const runtime=engine.newRuntime(),context=runtime.newContext()
runtime.setMemoryLimit(32*1024*1024);runtime.setMaxStackSize(512*1024)
const deadline=Date.now()+10000;runtime.setInterruptHandler(()=>Date.now()>deadline)
const factory=readFileSync('src/sandbox/guest-vm-modules.js','utf8').replace('export function createVMModules','function createVMModules')
const guest=readFileSync('src/sandbox/guest-vm.js','utf8').replace("import {createVMModules} from './guest-vm-modules.js'",factory)
const api=transformSync(guest,{format:'iife',globalName:'guestVM',target:'es2022'}).code
const source=`globalThis.__webContainerHost={vmModules:vmNative,compileScript:__qjsCompileScript,createContext:__qjsCreateContext};\n${api}\nconst {SourceTextModule,SyntheticModule}=guestVM;\n`+readFileSync('fixtures/vm-module-guest-cases.js','utf8').replace('  const check=',`  const context=guestVM.createContext({marker:43});
  const dep=new SyntheticModule(['value'],function(){this.setExport('value',43)},{context});await dep.link(()=>{});await dep.evaluate();
  const script=new guestVM.Script("()=>import('dep')",{importModuleDynamically:()=>dep});
  if((await script.runInContext(context)()).value!==43)throw Error('Context Script import');
  dep.dispose();
  const check=`)
let result
try{
  result=context.evalCode(source,'vm-module-candidate.js')
  if(result.error)throw Error(JSON.stringify(context.dump(result.error)))
  for(let i=0;i<1000;i++){
    const jobs=runtime.executePendingJobs()
    if(jobs.error){const error=context.dump(jobs.error);jobs.dispose();throw Error(JSON.stringify(error))}
    jobs.dispose()
    const state=context.getPromiseState(result.value)
    if(state.type==='rejected'){const error=context.dump(state.error);state.error.dispose();throw Error(JSON.stringify(error))}
    if(state.type==='fulfilled'){console.log(state.notAPromise?context.dump(result.value):context.dump(state.value));if(!state.notAPromise)state.value.dispose();break}
    if(i===999)throw Error('VM module candidate did not settle')
  }
}finally{result?.dispose();context.dispose();runtime.dispose()}
