import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'

const root=realpathSync(process.env.SDK_OUTPUT!)
const hosting=JSON.parse(readFileSync(resolve(root,'preview-host/hosting.json'),'utf8'))
let owner:Server,previewHost:Server,ownerURL:string,previewOrigin:string
const listen=async(server:Server)=>{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`
}
test.beforeAll(async()=>{
  owner=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname
    if(path==='/app/'){
      res.setHeader('Content-Type','text/html');res.end('<div id="preview"></div><script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk;</script>');return
    }
    try{
      if(!path.startsWith('/app/vendor/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice('/app/vendor/'.length))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  previewHost=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname
    const route=hosting.routes.find((route:any)=>route.path===path&&route.method===req.method)
    if(!route){res.writeHead(hosting.fallbackStatus,{'Content-Type':'text/plain'});res.end('No browser workspace attached');return}
    res.writeHead(200,route.headers);res.end(readFileSync(resolve(root,'preview-host',route.file)))
  })
  ownerURL=await listen(owner)+'/app/'
  previewOrigin=await listen(previewHost)
})
test.afterAll(async()=>{for(const server of [owner,previewHost])await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

for(const guestWasm of [false,true])test(`packaged Web API bootstrap preserves data types and streaming behavior: guestWasm=${guestWasm}`,async({page},info)=>{
  const source=`(async()=>{
    const text='hello 🌍',bytes=new TextEncoder().encode(text);
    const url=new URL('../next?q=a+b','https://example.test/base/path');
    const request=new Request('https://example.test/',{method:'POST',body:text});
    const copy=request.clone();
    const blob=new Blob([bytes],{type:'text/plain'});
    const form=new FormData();form.append('name','first');form.append('name','second');
    const stream=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}});
    const response=new Response(stream,{headers:{'x-test':'ok'}});
    const controller=new AbortController();controller.abort('done');
    console.log(JSON.stringify({names:[TextEncoder,TextDecoder,URL,Request,Response,Headers,Blob,FormData,ReadableStream,AbortController].map(x=>x.name),decoded:new TextDecoder().decode(bytes),url:url.href,query:url.searchParams.get('q'),body:await request.text(),clone:await copy.text(),blob:await blob.text(),blobType:blob.type,form:form.getAll('name'),stream:await response.text(),used:response.bodyUsed,header:response.headers.get('x-test'),aborted:controller.signal.aborted,reason:controller.signal.reason}));
  })().catch(error=>{console.error(error);process.exitCode=1});`
  const native=spawnSync(process.execPath,['-e',source],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  await page.goto(ownerURL);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const observed=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new (window as any).sdk.WorkerKernel({'/main.cjs':source},{experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000})
    try{return await kernel.runModule('/main.cjs',{webAPIs:true,guestWasm,maxBytes:128*1024*1024,timeoutMs:15000})}finally{kernel.close()}
  },{source,guestWasm})
  const path=info.outputPath('web-api-bootstrap.json')
  await writeFile(path,JSON.stringify({sdk:root,native:{stdout:native.stdout,status:native.status},observed},null,2))
  expect(observed.exitCode,observed.stderr).toBe(0)
  expect(JSON.parse(observed.stdout)).toEqual(JSON.parse(native.stdout))
})

test('HTTP transfers a client-sized module alongside a small response',async({page},info)=>{
  await page.goto(ownerURL)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const observed=await page.evaluate(async()=>{
    const {WorkerKernel,WorkerHTTP}=(window as any).sdk
    const source=`import http from 'node:http';const body='export const value=42;\\n'+'//0123456789abcdef\\n'.repeat(12000);http.createServer((req,res)=>{res.setHeader('content-type','text/javascript');res.end(req.url==='/client.mjs'?body:'export const small=1;')}).listen(8522,()=>console.log('READY'));`
    const kernel=new WorkerKernel({'/server.mjs':source},{experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000})
    const started=performance.now(),evidence:any={responses:[]}
    const timer=setTimeout(()=>kernel.close(new Error('HTTP fixture deadline')),15000)
    let child:any
    try{
      child=await kernel.spawn('node',['/server.mjs'],{lifetime:'session',webAPIs:true,timeoutMs:15000})
      let output=''
      for(;;){const event=await child.next();if(event?.type==='stdout')output+=new TextDecoder().decode(event.bytes);if(output.includes('READY'))break;if(!event||event.type==='exit')throw Error('Server did not start: '+output)}
      evidence.readyMs=performance.now()-started
      const http=new WorkerHTTP(kernel,8522)
      await Promise.all(['/client.mjs','/small.mjs'].map(async path=>{
        const began=performance.now(),response=await http.fetch(new Request('http://workspace'+path))
        const headersMs=performance.now()-began,body=await response.text()
        const expected=path==='/client.mjs'?'export const value=42;\n'+'//0123456789abcdef\n'.repeat(12000):'export const small=1;'
        evidence.responses.push({path,status:response.status,headersMs,totalMs:performance.now()-began,bytes:new TextEncoder().encode(body).length,exact:body===expected})
      }))
    }catch(error){evidence.error=String(error)}
    finally{clearTimeout(timer);try{await child?.dispose()}catch(error){evidence.cleanupError=String(error)}kernel.close()}
    evidence.elapsedMs=performance.now()-started
    return evidence
  })
  const evidencePath=info.outputPath('http-module-transfer.json')
  await writeFile(evidencePath,JSON.stringify({sdk:root,observed},null,2))
  await info.attach('http-module-transfer.json',{path:evidencePath,contentType:'application/json'})
  expect(observed.error).toBeUndefined()
  expect(observed.cleanupError).toBeUndefined()
  expect(observed.responses).toHaveLength(2)
  expect(observed.responses.every((response:any)=>response.status===200&&response.exact)).toBe(true)
})

for(const cooperative of [false,true])test(`packaged preview serves guest HTTP, POST, navigation and remount: cooperative=${cooperative}`,async({page,request},info)=>{
  const logs:string[]=[];page.on('console',message=>logs.push(message.text()));page.on('pageerror',error=>logs.push(error.message))
  expect((await request.get(previewOrigin+'/')).status()).toBe(503)
  await page.goto(ownerURL)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  try{
    await page.evaluate(async({previewOrigin,cooperative})=>{
      const {WorkerKernel,WorkerHTTP,URLPreview}=(window as any).sdk
      const html='<html><head><title>Guest app</title></head><body><button id="count">0</button><a href="/next">Next</a><script>document.querySelector("#count").onclick=async()=>{document.querySelector("#count").textContent=await (await fetch("/increment",{method:"POST",body:"increment"})).text()}</script></body></html>'
      const source=`import http from 'node:http';let count=0;http.createServer(async(req,res)=>{if(req.url==='/increment'){let body='';for await(const chunk of req)body+=chunk;res.end(body==='increment'?String(++count):'wrong body: '+JSON.stringify(body))}else{res.setHeader('content-type','text/html');res.end(${JSON.stringify(html)})}}).listen(8521,()=>console.log('READY'))`
      const kernel=new WorkerKernel({'/server.mjs':source},{cooperative})
      const state:any=(window as any).probe={kernel}
      state.child=await kernel.spawn('node',['/server.mjs'],{lifetime:'session',webAPIs:true,guestWasm:true,timeoutMs:30000})
      let logs=''
      for(;;){const event=await state.child.next();if(event?.type==='stdout'||event?.type==='stderr')logs+=new TextDecoder().decode(event.bytes);if(logs.includes('READY'))break;if(!event||event.type==='exit')throw Error(logs)}
      state.bodies=[]
      state.writes=[]
      const http=new WorkerHTTP({connect:async(...args:any[])=>{const socket=await kernel.connect(...args);return {...socket,write:async(bytes:Uint8Array)=>{state.writes.push(new TextDecoder().decode(bytes));return socket.write(bytes)}}}},8521)
      state.mount=()=>URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:{fetch:async(request:Request)=>{state.bodies.push({url:request.url,body:await request.clone().text()});return http.fetch(request)}}})
      state.preview=await state.mount()
    },{previewOrigin,cooperative})
    const frame=page.frameLocator('#preview iframe')
    await expect(frame.locator('#count')).toHaveText('0')
    await frame.locator('#count').click()
    await expect(frame.locator('#count')).toHaveText('1')
    await frame.locator('a').click()
    await expect.poll(()=>page.frames().some(frame=>frame.url()===previewOrigin+'/next')).toBe(true)
    await frame.locator('#count').click()
    await expect(frame.locator('#count')).toHaveText('2')
    const inaccessible=await frame.locator('body').evaluate(()=>{try{void parent.document.body;return false}catch{return true}})
    expect(inaccessible).toBe(true)
    await page.evaluate(async()=>{const state=(window as any).probe;state.preview.close();state.preview=await state.mount()})
    await expect(frame.locator('#count')).toHaveText('0')
    await frame.locator('#count').click()
    await expect(frame.locator('#count')).toHaveText('3')
    await info.attach('packaged-preview.json',{body:JSON.stringify(await page.evaluate(async()=>{const state=(window as any).probe;return {requests:state.preview.requests,inspection:await state.preview.inspect(),diagnostics:state.preview.diagnostics}})),contentType:'application/json'})
    await info.attach('packaged-preview.png',{body:await page.screenshot(),contentType:'image/png'})
  }finally{
    await info.attach('preview-console.json',{body:JSON.stringify(logs),contentType:'application/json'})
    await info.attach('preview-request-bodies.json',{body:JSON.stringify(await page.evaluate(()=>{const state=(window as any).probe;return {bodies:state?.bodies,writes:state?.writes}})),contentType:'application/json'})
    await page.evaluate(async()=>{const state=(window as any).probe;state?.preview?.close();try{await state?.child?.dispose()}finally{state?.kernel.close()}})
  }
  await expect(page.locator('iframe')).toHaveCount(0)
})
