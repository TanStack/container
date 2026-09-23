import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'
import {sdkEngineDirectories} from '../../scripts/sdk-build-profiles.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const profileEngines=sdkEngineDirectories(manifest.buildProfile)
const enabled=['quickjs-als-asyncify-atomics-fibers-shared-storage','quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'].every(slot=>Object.hasOwn(profileEngines,slot))
let server,url
test.beforeAll(async()=>{
  if(!enabled)return
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/consumer/'){
      res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk</script>');return
    }
    try{
      const relocated=path.startsWith('/consumer/relocated/')
      if(!relocated&&!path.startsWith('/consumer/vendor/'))throw Error('outside package')
      const base=relocated?resolve(root,'runtime'):root
      const prefix=relocated?'/consumer/relocated/':'/consumer/vendor/'
      const file=realpathSync(resolve(base,decodeURIComponent(path.slice(prefix.length))))
      if(!file.startsWith(base+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${server.address().port}/consumer/`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})
test.beforeEach(async()=>{test.skip(!enabled,'Requires SDK manifest buildProfile experimental-fibers')})

test('idle hosted compiler policy does not hide an unsettled top-level await',async({page},info)=>{
  test.skip(!manifest.experimentalRolldownParser,'Requires the opt-in hosted compiler artifact')
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const result=await page.evaluate(async()=>{
    const kernel=new window.sdk.WorkerKernel({'/main.mjs':'await new Promise(()=>{})'},{experimentalFibers:true,experimentalRolldownParser:{timeoutMs:1000,maxSourceBytes:1024},timeoutMs:1000})
    try{const child=await kernel.spawn('node',['/main.mjs'],{guestWasm:true,timeoutMs:1000,lifetime:'session'});return await child.wait()}
    finally{kernel.close();await kernel.shutdown}
  })
  await info.attach('idle-compiler-unsettled-await.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(13)
  expect(result.stderr).toContain('Unsettled top-level await')
})

test('packaged engine preserves callable live exports through a module cycle',async({page},info)=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const result=await page.evaluate(async()=>{
    const kernel=new window.sdk.WorkerKernel({
      '/main.mjs':`import * as server from './server.mjs';import {Router} from './router.mjs';import {replace} from './load.mjs';const router=new Router();const first=await router.load();replace();console.log(JSON.stringify({type:typeof server.load,first,second:await router.load()}));`,
      '/server.mjs':`import {load} from './load.mjs';export {load};`,
      '/load.mjs':`import {Router} from './router.mjs';export let load=async()=>42;export function replace(){load=async()=>43}`,
      '/router.mjs':`import {load} from './server.mjs';export class Router{constructor(){this.load=async()=>load()}}`,
    },{experimentalFibers:true,timeoutMs:10000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  })
  await info.attach('packaged-live-module-cycle.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({type:'function',first:42,second:43})
})

for(const guestWasm of [false,true])test(`packaged host budgets isolate shared storage, guestWasm=${guestWasm}`,async({page},info)=>{
  const requests=[];page.on('request',request=>requests.push(request.url()))
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const results=await page.evaluate(async guestWasm=>{
    const results=[]
    const kernels=[65536,131072].map(maxBytes=>new window.sdk.WorkerKernel({},{experimentalFibers:true,sharedMemoryPerEngine:{maxBytes},assetBaseURL:new URL('./relocated/',location.href).href,timeoutMs:20000}))
    try{
      for(const kernel of kernels)results.push(await kernel.execute(`let rejected=false,bytes=null;try{bytes=new SharedArrayBuffer(65537).byteLength}catch{rejected=true}console.log(JSON.stringify({rejected,bytes}))`,{guestWasm}))
      return results
    }finally{for(const kernel of kernels)kernel.close()}
  },guestWasm)
  await info.attach('packaged-host-budget.json',{body:JSON.stringify({results,requests}),contentType:'application/json'})
  for(const result of results)expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(results[0].stdout)).toEqual({rejected:true,bytes:null})
  expect(JSON.parse(results[1].stdout)).toEqual({rejected:false,bytes:65537})
  expect(requests.some(url=>url.includes(`/relocated/quickjs-als-asyncify${guestWasm?'-wasm':''}-atomics-fibers-shared-storage/engine.wasm`))).toBe(true)
  expect(requests.filter(url=>url.includes('/vendor/runtime/'))).toEqual([])
})

test('packaged host budget supports on-demand shared WASM growth with live old views',async({page},info)=>{
  const requests=[];page.on('request',request=>requests.push(request.url()))
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const result=await page.evaluate(async()=>{
    const kernel=new window.sdk.WorkerKernel({},{experimentalFibers:true,sharedMemoryPerEngine:{maxBytes:262144},assetBaseURL:new URL('./relocated/',location.href).href,timeoutMs:20000})
    try{return await kernel.execute(`
const memory=new WebAssembly.Memory({initial:1,maximum:65536,shared:true}),old=memory.buffer,view=new Int32Array(old);
view[0]=41;const previous=memory.grow(1),current=new Int32Array(memory.buffer);current[0]++;
console.log(JSON.stringify({previous,oldLength:old.byteLength,newLength:memory.buffer.byteLength,oldValue:view[0],value:current[0],newPageZero:new Uint8Array(memory.buffer,65536).every(value=>value===0)}));
`,{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  })
  await info.attach('packaged-shared-growth.json',{body:JSON.stringify({result,requests}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({previous:1,oldLength:65536,newLength:131072,oldValue:42,value:42,newPageZero:true})
  expect(requests.some(url=>url.includes('/relocated/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage/engine.wasm'))).toBe(true)
  expect(requests.filter(url=>url.includes('/vendor/runtime/'))).toEqual([])
})

for(const guestWasm of [false,true])test(`packaged relocated fiber engine executes and parks with guestWasm=${guestWasm}`,async({page},info)=>{
  const requests=[];page.on('request',request=>requests.push(request.url()))
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const result=await page.evaluate(async guestWasm=>{
    const kernel=new window.sdk.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';
const buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:buffer});
const exit=new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const waited=Atomics.wait(view,0,0,5000);
console.log(JSON.stringify({waited,value:Atomics.load(view,0),exit:await exit}));`,
      '/child.mjs':`import {workerData} from 'node:worker_threads';const view=new Int32Array(workerData);Atomics.store(view,0,42);Atomics.notify(view,0,1);`,
    },{experimentalFibers:true,assetBaseURL:new URL('./relocated/',location.href).href,timeoutMs:20000})
    try{
      const simple=await kernel.execute('console.log(6*7)',{guestWasm})
      const worker=await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:20000})
      return {simple,worker}
    }finally{kernel.close()}
  },guestWasm)
  await info.attach('packaged-fibers.json',{body:JSON.stringify({result,requests}),contentType:'application/json'})
  expect(result.simple.exitCode,result.simple.stderr).toBe(0);expect(result.simple.stdout).toBe('42\n')
  expect(result.worker.exitCode,result.worker.stderr).toBe(0)
  expect(JSON.parse(result.worker.stdout)).toEqual({waited:'ok',value:42,exit:0})
  expect(requests.some(url=>url.includes(`/relocated/quickjs-als-asyncify${guestWasm?'-wasm':''}-atomics-fibers-shared-storage/engine.wasm`))).toBe(true)
  expect(requests.filter(url=>url.includes('/vendor/runtime/'))).toEqual([])
})

test('packaged fiber worker clones a WASM module and shares its Memory control',async({page},info)=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const result=await page.evaluate(async()=>{
    const kernel=new window.sdk.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';
const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
const module=new WebAssembly.Module(bytes),memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true}),old=memory.buffer;bytes.fill(0);
const worker=new Worker(new URL('./child.mjs',import.meta.url),{workerData:{module,moduleAlias:module,memory,memoryAlias:memory}});
const exit=new Promise((resolve,reject)=>{worker.on('exit',resolve);worker.on('error',reject)});
const reply=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
console.log(JSON.stringify({reply,pages:memory.buffer.byteLength/65536,oldLength:old.byteLength,value:new Uint8Array(old)[0],exit:await exit}));`,
      '/child.mjs':`import {workerData,parentPort} from 'node:worker_threads';
const {module,moduleAlias,memory,memoryAlias}=workerData;
if(module!==moduleAlias||!(module instanceof WebAssembly.Module)||memory!==memoryAlias||!(memory instanceof WebAssembly.Memory))throw Error('Clone aliases or types lost');
memory.grow(1);new Uint8Array(memory.buffer)[0]=42;
parentPort.postMessage(new WebAssembly.Instance(module).exports.add(20,22));parentPort.close();`,
    },{experimentalFibers:true,assetBaseURL:new URL('./relocated/',location.href).href,timeoutMs:20000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  })
  await info.attach('packaged-fiber-wasm.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({reply:42,pages:2,oldLength:65536,value:42,exit:0})
})
