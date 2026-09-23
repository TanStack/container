import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'

let server:Server,url:string
const root=realpathSync(process.env.SDK_OUTPUT!)
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname
    if(path==='/consumer/'){
      res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk;</script>');return
    }
    try{
      const relocated=path.startsWith('/consumer/relocated/')
      if(!relocated&&!path.startsWith('/consumer/vendor/'))throw Error('outside package')
      const base=relocated?resolve(root,'runtime'):root
      const file=realpathSync(resolve(base,decodeURIComponent(path.slice((relocated?'/consumer/relocated/':'/consumer/vendor/').length))))
      if(!file.startsWith(base+sep))throw Error('outside package')
      const body=readFileSync(file)
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      res.end(body)
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${(server.address() as {port:number}).port}/consumer/`
})
test.afterAll(async()=>{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

test('packaged AgentSession exposes bounded model-agnostic tools',async({page})=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async()=>{
    const {AgentSession,AGENT_TOOL_DEFINITIONS}=(window as any).sdk
    const session=new AgentSession({'/app.mjs':'console.log("agent")'},{maxOutputBytes:1024})
    try{return {names:AGENT_TOOL_DEFINITIONS.map((tool:any)=>tool.name),list:await session.call('list',{path:'/'}),run:await session.call('run',{command:'node',args:['/app.mjs']})}}
    finally{session.close()}
  })
  expect(result.names).toContain('snapshot');expect(result.list.ok).toBe(true);expect(result.run,JSON.stringify(result.run)).toMatchObject({ok:true,value:{stdout:'agent\n',status:0,truncated:false}})
})

test('owner can relocate all runtime assets independently of SDK chunks',async({page},info)=>{
  const requests:string[]=[];page.on('request',request=>requests.push(request.url()))
  await page.goto(url)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const results=await page.evaluate(async()=>{
    const {WorkerKernel,runMvdanShell}=(window as any).sdk
    const kernel=new WorkerKernel({'/project/main.mjs':`console.log(await new Response('relocated').text())`},{cooperative:true,assetBaseURL:new URL('./relocated/',location.href).href})
    try{
      const results=[]
      for(const guestWasm of [false,true])results.push(await kernel.runModule('/project/main.mjs',{webAPIs:true,guestWasm}))
      const shell=await runMvdanShell(kernel,'printf relocated',{timeoutMs:30000})
      return {results,shell:{code:shell.code,text:new TextDecoder().decode(shell.stdout)}}
    }finally{kernel.close()}
  })
  await info.attach('relocated-assets.json',{body:JSON.stringify({requests,results}),contentType:'application/json'})
  for(const result of results.results){expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe('relocated\n')}
  expect(results.shell).toEqual({code:0,text:'relocated'})
  expect(requests.some(request=>request.includes('/relocated/quickjs-als-asyncify-cooperative/'))).toBe(true)
  expect(requests.some(request=>request.includes('/relocated/quickjs-als-asyncify-wasm-cooperative/'))).toBe(true)
  expect(requests.some(request=>request.includes('/relocated/mvdan-shell/'))).toBe(true)
  expect(requests.filter(request=>request.includes('/vendor/runtime/'))).toEqual([])
})

test('HTTP adapter preserves native request bodies and byte lengths',async({page},info)=>{
  await page.goto(url)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const results=await page.evaluate(async()=>{
    const {WorkerHTTP}=(window as any).sdk
    const results=[]
    for(const body of ['increment','héllo',new Uint8Array([0,255,13,10]),new URLSearchParams({key:'a b'}),new Blob(['blob body']),null]){
      const request=new Request('http://guest.invalid/post',{method:'POST',body})
      const expected=[...new Uint8Array(await request.clone().arrayBuffer())]
      const writes:Uint8Array[]=[]
      const http=new WorkerHTTP({connect:async()=>({write:async(bytes:Uint8Array)=>{writes.push(bytes.slice())},read:async()=>({type:'data',bytes:new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')}),close:async()=>{}})},80)
      const hasStream=Boolean(request.body)
      const response=await http.fetch(request)
      const text=await response.text()
      const header=new TextDecoder().decode(writes[0])
      const actual=writes.slice(1).flatMap(bytes=>[...bytes])
      results.push({hasStream,expected,actual,header,text})
    }
    return results
  })
  await info.attach('http-body-transport.json',{body:JSON.stringify(results),contentType:'application/json'})
  for(const result of results){
    expect(result.actual).toEqual(result.expected)
    if(result.expected.length)expect(result.header).toContain('content-length: '+result.expected.length+'\r\n')
    expect(result.text).toBe('ok')
  }
})

for(const cooperative of [false,true])test(`WASI virtual files match native reads writes and seek: cooperative=${cooperative}`,async({page})=>{
  const directory=mkdtempSync(resolve(tmpdir(),'sdk-wasi-control-'))
  writeFileSync(resolve(directory,'input.txt'),'hello WASI')
  const native=spawnSync(process.execPath,['fixtures/wasi-files.mjs'],{encoding:'utf8',timeout:10000,env:{...process.env,WASI_FIXTURE_ROOT:directory}})
  expect(native.status,native.stderr).toBe(0)
  await page.goto(url)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async({cooperative,source})=>{
    const {WorkerKernel}=(window as any).sdk
    const kernel=new WorkerKernel({'/main.mjs':source,'/data/input.txt':'hello WASI'},{cooperative})
    try{
      const run=await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,writable:true})
      return {run,output:run.exitCode===0?await kernel.readText('/data/output.txt'):null}
    }finally{kernel.close()}
  },{cooperative,source:readFileSync('fixtures/wasi-files.mjs','utf8')})
  expect(result.run.exitCode,result.run.stderr).toBe(0)
  expect(result.run.stdout).toBe(native.stdout)
  expect(JSON.parse(result.run.stdout).codes.every((code:number)=>code===0)).toBe(true)
  expect(result.output).toBe(readFileSync(resolve(directory,'output.txt'),'utf8'))
})

for(const growthReservation of [false,true])test(`shared WASM workers match native atomics wait and growth: fibers=true, reservation=${growthReservation}`,async({page},info)=>{
  const cooperative=false
  const files=Object.fromEntries(['main.mjs','worker.mjs','atomic.wasm'].map(name=>['/'+name,name.endsWith('.wasm')?[...readFileSync('fixtures/shared-wasm/'+name)]:readFileSync('fixtures/shared-wasm/'+name,'utf8')]))
  const native=spawnSync(process.execPath,['fixtures/shared-wasm/main.mjs'],{encoding:'utf8',timeout:10000})
  await info.attach('native-shared-wasm.json',{body:JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr}),contentType:'application/json'})
  expect(native.status,native.stderr).toBe(0)
  expect(JSON.parse(native.stdout)).toEqual({counter:16,notified:1,oldBytes:65536,newBytes:131072,upperPage:27})
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async({cooperative,files,growthReservation})=>{
    const kernel=new (window as any).sdk.WorkerKernel(Object.fromEntries(Object.entries(files).map(([name,value])=>[name,Array.isArray(value)?new Uint8Array(value):value])),{experimentalFibers:true,sharedMemoryPerEngine:{growthReservation},cooperative,timeoutMs:10000})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:10000})}
    finally{kernel.close()}
  },{cooperative,files,growthReservation})
  await info.attach('guest-shared-wasm.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(native.stdout)
})

test('shared WASM workers reject combining fiber and cooperative engines',async({page})=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const error=await page.evaluate(async()=>{
    const kernel=new (window as any).sdk.WorkerKernel({},{experimentalFibers:true,cooperative:true})
    try{await kernel.execute('42');return null}catch(error){return String(error)}finally{kernel.close()}
  })
  expect(error).toContain('Fiber and cooperative candidates cannot be combined')
})

for(const fixture of ['require-esm','require-esm-tla','require-esm-default'])for(const cooperative of [false,true])for(const guestWasm of [false,true])test(`${fixture} native semantics: cooperative=${cooperative}, guestWasm=${guestWasm}`,async({page})=>{
  const names=['main.mjs','value.mjs',...(fixture==='require-esm-tla'?['async.mjs']:fixture==='require-esm-default'?['marker.mjs','custom.mjs']:[])]
  const files=Object.fromEntries(names.map(name=>['/'+name,readFileSync('fixtures/'+fixture+'/'+name,'utf8')]))
  const native=spawnSync(process.execPath,['fixtures/'+fixture+'/main.mjs'],{encoding:'utf8',timeout:10000})
  expect(native.status,native.stderr).toBe(0)
  await page.goto(url)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async({cooperative,guestWasm,files})=>{
    const {WorkerKernel}=(window as any).sdk
    const kernel=new WorkerKernel(files,{cooperative})
    try{return await kernel.runModule('/main.mjs',{guestWasm})}
    finally{kernel.close()}
  },{cooperative,guestWasm,files})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(native.stdout)
  if(fixture!=='require-esm-default')expect(JSON.parse(result.stdout)).toEqual(fixture==='require-esm'?{same:true,value:42,stayedQueued:true,evaluations:1}:{code:'ERR_REQUIRE_ASYNC_MODULE',untouched:true,value:42,ran:true})
})

test('WASM diagnostics aggregate operations without detailed job profiling',async({page})=>{
  await page.goto(url)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async()=>{
    const {WorkerKernel}=(window as any).sdk
    const kernel=new WorkerKernel()
    try{
      const run=await kernel.execute(`const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]);const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes));console.log(instance.exports.answer()+instance.exports.answer())`,{guestWasm:true,diagnostics:true,profileJobs:false})
      return {run,operations:kernel.jobProfile}
    }finally{kernel.close()}
  })
  expect(result.run.exitCode,result.run.stderr).toBe(0)
  expect(result.run.stdout).toBe('84\n')
  for(const [phase,calls] of [['wasm-compile-total',1],['wasm-instantiate-total',1],['wasm-call-inclusive-total',2]] as const){
    const totals=result.operations.filter((row:any)=>row.phase===phase)
    expect(totals).toHaveLength(1)
    expect(totals[0].jobs).toBe(calls)
    expect(totals[0].ms).toBeGreaterThanOrEqual(0)
  }
  expect(result.operations.some((row:any)=>row.phase==='wasm-import')).toBe(false)
})

test('packaged util.parseEnv exposes matching ESM and CommonJS exports',async({page})=>{
  await page.goto(url)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async()=>{
    const {WorkerKernel}=(window as any).sdk
    const source=`
      import util,{parseEnv} from 'node:util';
      import {createRequire} from 'node:module';
      const require=createRequire(import.meta.url);
      const text='export MODE=development\\nPORT=4173\\nMESSAGE="hello # world"\\nPORT=4187';
      console.log(JSON.stringify({esm:parseEnv(text),cjs:require('node:util').parseEnv(text),same:util.parseEnv===parseEnv}));
    `
    const kernel=new WorkerKernel({'/main.mjs':source},{cooperative:true})
    try{return await kernel.runModule('/main.mjs')}
    finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  const expected={MODE:'development',PORT:'4187',MESSAGE:'hello # world'}
  expect(JSON.parse(result.stdout)).toEqual({esm:expected,cjs:expected,same:true})
})

for(const guestWasm of [false,true])test(`cooperative module hooks stay synchronous across scheduling slices: guestWasm=${guestWasm}`,async({page},info)=>{
  await page.goto(url)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async guestWasm=>{
    const {WorkerKernel}=(window as any).sdk
    const source=`
      import {registerHooks} from 'node:module';
      const calls=[];
      function work(kind){
        const started=Date.now();
        let elapsed=0;
        for(let index=0;index<10000000;index++){
          elapsed=Date.now()-started;
          if(elapsed>=25)break;
        }
        if(elapsed<25)throw Error('Hook did not cross a scheduling slice');
        calls.push(kind);
      }
      const hooks=registerHooks({
        resolve(specifier,context,next){work('resolve');return next(specifier,context)},
        load(url,context,next){work('load');return next(url,context)},
      });
      try{
        const value=await import('./value.mjs');
        console.log(JSON.stringify({value:value.default,calls}));
      }finally{hooks.deregister()}
    `
    const kernel=new WorkerKernel({'/main.mjs':source,'/value.mjs':'export default 42'},{cooperative:true})
    try{return await kernel.runModule('/main.mjs',{guestWasm,timeoutMs:5000})}
    finally{kernel.close()}
  },guestWasm)
  await info.attach('cooperative-module-hooks.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({value:42,calls:['resolve','load']})
})

for(const cooperative of [false,true])for(const guestWasm of [false,true])test(`static SDK: cooperative=${cooperative}, guestWasm=${guestWasm}`,async({page},info)=>{
  const requests:string[]=[],failures:string[]=[]
  page.on('request',request=>requests.push(request.url()))
  page.on('response',response=>{if(response.status()>=400)failures.push(response.url())})
  await page.goto(url)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async({cooperative,guestWasm})=>{
    const {WorkerKernel,runMvdanShell}=(window as any).sdk
    const kernel=new WorkerKernel({'/project/package.json':'{}','/main.mjs':`import fs from 'node:fs';console.log(fs.readFileSync('/input.txt','utf8'))`,'/input.txt':'standalone','/entry.ts':'const value:number=42;console.log(value)'},{cooperative})
    try{
      const module=await kernel.runModule('/main.mjs',{webAPIs:true,guestWasm})
      const compiled=await kernel.run('/entry.ts',{guestWasm})
      const wasm=guestWasm?await kernel.execute(`const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]);console.log(new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.answer())`,{guestWasm}):null
      const shell=await runMvdanShell(kernel,`node /main.mjs | node -e 'process.stdin.on("data",chunk=>process.stdout.write(chunk))'`,{timeoutMs:30000})
      return {module,compiled,wasm,shell:{code:shell.code,stdout:new TextDecoder().decode(shell.stdout),error:shell.error}}
    }finally{kernel.close()}
  },{cooperative,guestWasm})
  await info.attach('static-consumer.json',{body:JSON.stringify({result,requests,failures}),contentType:'application/json'})
  expect(result.module.exitCode,result.module.stderr).toBe(0)
  expect(result.module.stdout).toBe('standalone\n')
  expect(result.compiled.exitCode,result.compiled.stderr).toBe(0)
  expect(result.compiled.stdout).toBe('42\n')
  if(guestWasm){expect(result.wasm.exitCode,result.wasm.stderr).toBe(0);expect(result.wasm.stdout).toBe('42\n')}
  expect(result.shell).toEqual({code:0,stdout:'standalone\n',error:''})
  expect(failures).toEqual([])
  expect(requests.every(request=>request.startsWith(url))).toBe(true)
})
