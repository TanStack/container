import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {transform} from 'esbuild'
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core'
import SYNC from '@jitl/quickjs-wasmfile-release-sync'
import {vmContextCases} from '../fixtures/vm-context-cases.mjs'

const directory=resolve(process.argv[2]??'public/quickjs-als-oz')
const loader=(await import(pathToFileURL(resolve(directory,'engine.mjs')).href)).default
const engine=await newQuickJSWASMModuleFromVariant(newVariant({...SYNC,importModuleLoader:async()=>loader},{wasmBinary:readFileSync(resolve(directory,'engine.wasm'))}))
const vmSource=readFileSync('src/sandbox/guest-vm-modules.js','utf8').replace('export function createVMModules','function createVMModules')+'\n'+readFileSync('src/sandbox/guest-vm.js','utf8').replace("import {createVMModules} from './guest-vm-modules.js'",'')
const source=(await transform(vmSource,{format:'iife',globalName:'guestVM',target:'es2022'})).code
const bootstrap=readFileSync('src/sandbox/engine-als-bootstrap.js','utf8'),rows=[]
for(const fixture of vmContextCases){
  const node=spawnSync(process.execPath,['--input-type=module'],{input:`import vm from 'node:vm';import {AsyncLocalStorage} from 'node:async_hooks';\n${fixture.code}`,encoding:'utf8',timeout:5000})
  if(node.status!==0)throw Error('Node reference failed: '+fixture.name+'\n'+node.stderr)
  const runtime=engine.newRuntime(),context=runtime.newContext(),output=[]
  runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
  const deadline=Date.now()+5000;runtime.setInterruptHandler(()=>Date.now()>deadline)
  const pump=context.getProp(context.global,'__qjsExecutePendingJobs')
  let error
  try{
    const print=context.newFunction('print',value=>{output.push(context.getString(value))});context.setProp(context.global,'print',print);print.dispose()
    context.unwrapResult(context.evalCode('globalThis.__webContainerHost={compileScript:__qjsCompileScript,createContext:__qjsCreateContext};delete globalThis.__qjsCompileScript;'+bootstrap+';globalThis.AsyncLocalStorage=__engineAsyncLocalStorage;delete globalThis.__engineAsyncLocalStorage;globalThis.console={log:print};'+source+';globalThis.vm=guestVM.default;')).dispose()
    const result=context.evalCode(fixture.code,'probe.mjs',{type:'module'})
    try{
      if(result.error)error=context.dump(result.error)
      else for(let i=0;i<100;i++){
        const jobs=context.callFunction(pump,context.undefined)
        if(jobs.error){error=context.dump(jobs.error);jobs.dispose();break}jobs.dispose()
        const state=context.getPromiseState(result.value)
        if(state.type==='rejected'){error=context.dump(state.error);state.error.dispose();break}
        if(state.type==='fulfilled'){if(!state.notAPromise)state.value.dispose();break}
        if(i===99)error='Pending jobs did not settle'
      }
    }finally{result.dispose()}
  }finally{pump.dispose();context.dispose();runtime.dispose()}
  const actual=output.join('\n')+'\n',expected=fixture.kind==='policy'?fixture.expected:node.stdout,passed=!error&&actual===expected
  rows.push({name:fixture.name,kind:fixture.kind??'node-comparison',passed,actual,expected,nodeReference:node.stdout,error})
  console.log((passed?(fixture.kind==='policy'?'POLICY PASS':'MATCH'):'GAP')+' '+fixture.name+(passed?'':': '+JSON.stringify({error,actual,expected})))
}
writeFileSync(process.argv[3]??'reports/vm-contexts-native.json',JSON.stringify({generatedAt:new Date().toISOString(),node:process.version,engine:JSON.parse(readFileSync(resolve(directory,'build.json'),'utf8')),rows},null,2)+'\n')
if(rows.some(row=>!row.passed))process.exitCode=1
