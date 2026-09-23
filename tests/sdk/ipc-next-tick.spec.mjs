import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync,mkdirSync} from 'node:fs'
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

const source="const {fork}=require('node:child_process');\nconst childSource=`const events=[];process.on('message',()=>{events.push('message');process.nextTick(()=>events.push('tick'));Promise.resolve().then(()=>events.push('promise'));queueMicrotask(()=>events.push('microtask'));setImmediate(()=>process.send(events,()=>process.disconnect()))});`;\nrequire('node:fs').writeFileSync('./ipc-child.cjs',childSource);const child=fork('./ipc-child.cjs',{silent:true});\nconst events=[];let childEvents;\nchild.on('message',value=>{childEvents=value;events.push('message');process.nextTick(()=>events.push('message:tick'));Promise.resolve().then(()=>events.push('message:promise'));queueMicrotask(()=>events.push('message:microtask'))});\nchild.on('disconnect',()=>{events.push('disconnect');process.nextTick(()=>events.push('disconnect:tick'));Promise.resolve().then(()=>events.push('disconnect:promise'));queueMicrotask(()=>events.push('disconnect:microtask'))});\nchild.on('error',error=>{throw error});\nchild.on('close',code=>setImmediate(()=>console.log(JSON.stringify({code,childEvents,events}))));\nchild.send('go');"

test('IPC message and disconnect callbacks drain nextTick before microtasks',async({page},info)=>{
 test.setTimeout(60000)
 const cwd=info.outputPath('native');mkdirSync(cwd,{recursive:true})
 const native=spawnSync(process.execPath,['-e',source],{cwd,encoding:'utf8',timeout:15000})
 expect(native.status,native.stderr).toBe(0)
 const expected=JSON.parse(native.stdout.trim())
 expect(expected.childEvents).toEqual(['message','tick','promise','microtask'])
 for(const phase of ['message','disconnect'])expect(expected.events.filter(value=>value===phase||value.startsWith(phase+':'))).toEqual([phase,phase+':tick',phase+':promise',phase+':microtask'])
 await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
 const observed=await page.evaluate(async source=>{
  const kernel=new window.sdk.WorkerKernel({'/main.cjs':source},{experimentalFibers:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,timeoutMs:15000})
  try{return await kernel.runModule('/main.cjs',{guestWasm:true,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
 },source)
 const path=info.outputPath('ipc-next-tick.json')
 await writeFile(path,JSON.stringify({sdk:root,native:expected,observed},null,2))
 await info.attach('ipc-next-tick.json',{path,contentType:'application/json'})
 expect(observed.exitCode,observed.stderr).toBe(0)
 expect(JSON.parse(observed.stdout.trim())).toEqual(expected)
})
