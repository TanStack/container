import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const source=`import {Script,createContext,SyntheticModule,SourceTextModule} from 'node:vm';
const context=createContext({marker:42});
const dependency=new SyntheticModule(['value'],function(){this.setExport('value',17)},{context});
const root=new SourceTextModule("import {value} from 'dep';export {value};export const marker=globalThis.marker;export const meta=import.meta.answer",{context,initializeImportMeta(meta){meta.answer=23}});
const bad=new SourceTextModule("import 'missing'",{context});
let rejected=false;try{await bad.link(()=>{throw Error('missing')})}catch{rejected=true}
await root.link(async()=>dependency);const linked=root.status;await root.evaluate();
dependency.setExport('value',24);
const a=new SourceTextModule("import {b} from 'b';export function a(){return b()};export const value=7",{context});
const b=new SourceTextModule("import {value} from 'a';export function b(){return value}",{context});
await a.link(async name=>name==='a'?a:b);await a.evaluate();
const thrown=new SourceTextModule("throw new Error('fixture failure')",{context});await thrown.link(()=>{});
let identity=false;try{await thrown.evaluate()}catch(error){identity=error===thrown.error}
const dynamic=new SourceTextModule("export const load=()=>import('dep')",{context,importModuleDynamically:()=>dependency});await dynamic.link(()=>{});await dynamic.evaluate();
const dynamicValue=(await dynamic.namespace.load()).value;
const script=new Script("()=>import('dep')",{importModuleDynamically:()=>dependency});const scriptValue=(await script.runInContext(context)()).value;
const namespaceScript=new Script("import('dep')",{importModuleDynamically:()=>dependency.namespace});if(await namespaceScript.runInContext(context)!==dependency.namespace)throw Error('Namespace identity');
console.log(JSON.stringify({linked,status:root.status,rejected,value:root.namespace.value,marker:root.namespace.marker,meta:root.namespace.meta,cycle:a.namespace.a(),identity,errorStatus:thrown.status,dynamicValue,scriptValue}));`

for(const guestWasm of [false,true])test(`opt-in VM module lifecycle ${guestWasm?'WASM':'default'}`,async({page})=>{
  const native=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',source],{encoding:'utf8',timeout:10000})
  expect(native.status,native.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm,timeoutMs:10000})}finally{kernel.close()}
  },{source,guestWasm})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(native.stdout)
})
test('VM module disposal and unsupported options are explicit',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`
      import {SourceTextModule} from 'node:vm';
      const m=new SourceTextModule('export const value=1');m.dispose();m.dispose();
      const codes=[];for(const options of [{cachedData:new Uint8Array()}]){
        try{new SourceTextModule('',options)}catch(error){codes.push(error.code)}
      }
      console.log(JSON.stringify({status:m.status,codes}));`})
    try{return await kernel.runModule('/main.mjs',{timeoutMs:10000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({status:'disposed',codes:['ERR_UNSUPPORTED_OPERATION']})
})
