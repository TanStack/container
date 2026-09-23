import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'

const root=realpathSync(process.env.SDK_OUTPUT)
let server,url
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

const source=`import {Worker} from 'node:worker_threads';
const events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);
const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads');const view=new Int32Array(workerData);parentPort.once('message',()=>{parentPort.postMessage('done');Atomics.store(view,0,1);Atomics.notify(view,0)});parentPort.postMessage('ready');",{eval:true,execArgv:['--input-type=commonjs'],workerData:buffer});
try{
 await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
 const message=new Promise(resolve=>worker.once('message',()=>{events.push('message');resolve()}));
 const batch=new Promise(resolve=>{
  for(let i=0;i<6;i++)setImmediate(()=>{
   events.push('immediate:'+i);
   if(i===0){worker.postMessage('run');if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('worker acknowledgement timed out');events.push('worker-posted')}
   Promise.resolve().then(()=>events.push('promise:'+i)).then(()=>{events.push('continuation:'+i);if(i===5)resolve()});
  });
 });
 await Promise.all([message,batch]);console.log(JSON.stringify(events));
}finally{await worker.terminate()}`

test('worker completion posted during an existing immediate batch matches Node',async({page},info)=>{
  test.setTimeout(60000)
  const controls=Array.from({length:3},()=>spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000}))
  for(const run of controls)expect(run.status,run.stderr).toBe(0)
  const expected=JSON.parse(controls[0].stdout.trim())
  for(const run of controls)expect(JSON.parse(run.stdout.trim())).toEqual(expected)
  expect(expected.indexOf('message')).toBeGreaterThan(expected.indexOf('continuation:5'))
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async source=>{
    const kernel=new window.sdk.WorkerKernel({'/main.mjs':source},{experimentalFibers:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,timeoutMs:15000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },source)
  const evidencePath=info.outputPath('worker-check-batch.json')
  await writeFile(evidencePath,JSON.stringify({sdk:root,native:expected,nativeRuns:controls.map(run=>JSON.parse(run.stdout.trim())),observed},null,2))
  await info.attach('worker-check-batch.json',{path:evidencePath,contentType:'application/json'})
  expect(observed.exitCode,observed.stderr).toBe(0)
  expect(JSON.parse(observed.stdout.trim())).toEqual(expected)
})

const reusedPortSource=`import {Worker} from 'node:worker_threads';
const events=[],buffer=new SharedArrayBuffer(8),view=new Int32Array(buffer);
const workerSource="const {parentPort,workerData}=require('node:worker_threads');const view=new Int32Array(workerData.buffer);parentPort.on('message',value=>{parentPort.postMessage(value);Atomics.add(view,workerData.slot,1);Atomics.notify(view,workerData.slot)});parentPort.postMessage('ready');";
const workers=[0,1].map(slot=>new Worker(workerSource,{eval:true,execArgv:['--input-type=commonjs'],workerData:{buffer,slot}}));
function sent(slot,previous){if(Atomics.wait(view,slot,previous,5000)==='timed-out')throw Error('worker acknowledgement timed out')}
try{
 await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)})));
 let finishMessage,finishImmediate;
 const message=new Promise(resolve=>finishMessage=resolve),immediate=new Promise(resolve=>finishImmediate=resolve);
 workers[0].on('message',value=>{events.push('A:'+value);if(value==='first'){workers[1].postMessage('trigger');sent(1,0)}else finishMessage()});
 workers[1].once('message',()=>{events.push('B:trigger');workers[0].postMessage('second');sent(0,1);events.push('A:second-posted');setImmediate(()=>{events.push('immediate');finishImmediate()})});
 workers[0].postMessage('first');sent(0,0);
 await Promise.all([message,immediate]);console.log(JSON.stringify(events));
}finally{await Promise.all(workers.map(worker=>worker.terminate()))}`

test('a drained worker port made ready by another port matches Node',async({page},info)=>{
  test.setTimeout(60000)
  const controls=Array.from({length:5},()=>spawnSync(process.execPath,['--input-type=module','-e',reusedPortSource],{encoding:'utf8',timeout:15000}))
  for(const run of controls)expect(run.status,run.stderr).toBe(0)
  const expected=JSON.parse(controls[0].stdout.trim())
  for(const run of controls)expect(JSON.parse(run.stdout.trim())).toEqual(expected)
  expect(expected.slice(0,3)).toEqual(['A:first','B:trigger','A:second-posted'])
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async source=>{
    const kernel=new window.sdk.WorkerKernel({'/main.mjs':source},{experimentalFibers:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,timeoutMs:15000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },reusedPortSource)
  const evidencePath=info.outputPath('worker-reused-port.json')
  await writeFile(evidencePath,JSON.stringify({sdk:root,native:expected,nativeRuns:controls.map(run=>JSON.parse(run.stdout.trim())),observed},null,2))
  await info.attach('worker-reused-port.json',{path:evidencePath,contentType:'application/json'})
  expect(observed.exitCode,observed.stderr).toBe(0)
  expect(JSON.parse(observed.stdout.trim())).toEqual(expected)
})
