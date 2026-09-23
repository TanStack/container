import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {transform} from 'esbuild'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'

const directory=resolve(process.argv[2]??'public/quickjs-als')
const loader=(await import(pathToFileURL(resolve(directory,'engine.mjs')).href)).default
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:await readFile(resolve(directory,'engine.wasm'))}))
const vmSource=(await readFile('src/sandbox/guest-vm-modules.js','utf8')).replace('export function createVMModules','function createVMModules')+'\n'+(await readFile('src/sandbox/guest-vm.js','utf8')).replace("import {createVMModules} from './guest-vm-modules.js'",'')
const source=(await transform(vmSource,{format:'iife',globalName:'guestVM',target:'es2022'})).code
const cases=JSON.parse(await readFile('fixtures/guest-script-cases.json','utf8')),results=[]
for(const fixture of cases){
  const node=spawnSync(process.execPath,['--input-type=module'],{input:`import vm from 'node:vm';\n${fixture.code}`,encoding:'utf8',timeout:5000})
  if(node.status!==0)throw Error('Node reference failed: '+fixture.name+'\n'+node.stderr)
  const runtime=engine.newRuntime(),context=runtime.newContext(),output=[]
  const deadline=Date.now()+5000
  runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024);runtime.setInterruptHandler(()=>Date.now()>deadline)
  let error
  try{
    const print=context.newFunction('print',value=>{output.push(context.getString(value))});context.setProp(context.global,'print',print);print.dispose()
    context.unwrapResult(context.evalCode('globalThis.__webContainerHost={compileScript:__qjsCompileScript};delete globalThis.__qjsCompileScript;globalThis.console={log:print};'+source+';globalThis.vm=guestVM.default;')).dispose()
    const result=context.evalCode(fixture.code,'probe.mjs',{type:'module'})
    try{
      if(result.error)error=context.dump(result.error)
      else for(let i=0;i<100;i++){
        const jobs=runtime.executePendingJobs(100);if(jobs.error){error=context.dump(jobs.error);jobs.dispose();break}jobs.dispose()
        const state=context.getPromiseState(result.value)
        if(state.type==='rejected'){error=context.dump(state.error);state.error.dispose();break}
        if(state.type==='fulfilled'){if(!state.notAPromise)state.value.dispose();break}
        if(i===99)error='Pending jobs did not settle'
      }
    }finally{result.dispose()}
  }finally{context.dispose();runtime.dispose()}
  const actual=output.join('\n')+'\n',passed=!error&&actual===node.stdout
  results.push({name:fixture.name,passed,expected:node.stdout,actual,error});console.log(fixture.name,passed?'PASS':JSON.stringify({error,actual,expected:node.stdout}))
}
await writeFile(process.argv[3]??'reports/guest-script-native.json',JSON.stringify({generatedAt:new Date().toISOString(),engine:JSON.parse(await readFile(resolve(directory,'build.json'),'utf8')),results},null,2)+'\n')
if(results.some(result=>!result.passed))process.exitCode=1
