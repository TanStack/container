import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const installed=readFileSync('fixtures/workloads/node_modules/rolldown/dist/shared/dist-DKbukT1H.mjs','utf8')
test('installed Rolldown freshImport resolve hooks track dependencies and refresh module graphs',async({page})=>{
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async(installed)=>{
  const kernel=new window.sandboxLab.WorkerKernel({
   '/fresh.mjs':installed,
   '/entry.mjs':`import {value} from './dependency.mjs';export default value;`,
   '/dependency.mjs':`export const value=42;`,
   '/main.mjs':`import {freshImport} from './fresh.mjs';const first=await freshImport('file:///entry.mjs');const second=await freshImport('file:///entry.mjs');console.log(JSON.stringify({value:first.result.default,dependencies:first.dependencies,fresh:first.result!==second.result}));`,
  })
  try{return await kernel.runModule('/main.mjs',{webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
 },installed)
 expect(result.exitCode,result.stderr).toBe(0)
 expect(JSON.parse(result.stdout)).toEqual({value:42,dependencies:['/dependency.mjs'],fresh:true})
})
test('explicit async source preparation uses a transferred loader port before importing',async({page})=>{
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async()=>{
  const source=`import {preloadModuleSources} from 'node:module';import {Worker,MessageChannel} from 'node:worker_threads';
   const {port1,port2}=new MessageChannel();
   const worker=new Worker('const {workerData}=require("node:worker_threads");const port=workerData.port;port.on("message",source=>port.postMessage(source.replace("1","42")));port.postMessage("ready");',{eval:true,execArgv:['--input-type=commonjs'],workerData:{port:port2},transferList:[port2]});
   const ready=new Promise(resolve=>port1.once('message',resolve));
   const registration=await preloadModuleSources(['file:///value.mjs'],{
    initialize:()=>ready,
    async load(url,context,next){const original=await next();const transformed=new Promise(resolve=>port1.once('message',resolve));port1.postMessage(original.source);return {...original,source:await transformed}},
    async dispose(){port1.close();await worker.terminate()}
   });
   console.log((await import('./value.mjs')).default);registration.deregister();`
  const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source,'/value.mjs':'export default 1'})
  try{return await kernel.runModule('/main.mjs',{webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
 })
 expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout.trim()).toBe('42')
})
