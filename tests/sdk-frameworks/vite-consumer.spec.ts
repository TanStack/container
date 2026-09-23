import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {createHash} from 'node:crypto'
import {observeSDKEngines} from '../sdk/engine-evidence'
import {prepareStrictSplitAssets,strictSDKFile} from './split-assets.mjs'

const root=realpathSync(process.env.SDK_OUTPUT!)
const runtimeRoot=process.env.SDK_RUNTIME_OUTPUT&&realpathSync(process.env.SDK_RUNTIME_OUTPUT)
let split:Awaited<ReturnType<typeof prepareStrictSplitAssets>>
const nativeCompiler=process.env.SDK_NATIVE_COMPILER==='1'
const hosting=JSON.parse(readFileSync(resolve(runtimeRoot||root,'preview-host/hosting.json'),'utf8'))
// Complete existing registry lock, including Vitest. This is not the Vite 8 acceptance.
const files:Record<string,string>={}
for(const name of ['package.json','package-lock.json'])files['/project/'+name]=readFileSync('fixtures/install-vitest/'+name,'utf8')
Object.assign(files,{
  '/project/index.html':'<!doctype html><html><head><title>Vite workspace</title></head><body><h1 id="message"></h1><button id="count">0</button><script type="module" src="/main.ts"></script></body></html>',
  '/project/message.js':'export const message = "Original message";\n',
  '/project/main.ts':`import {message} from './message.js';
document.querySelector('#message').textContent=message;
let count=0;document.querySelector('#count').onclick=()=>document.querySelector('#count').textContent=String(++count);
if(import.meta.hot)import.meta.hot.accept('./message.js',module=>{document.querySelector('#message').textContent=module.message});`,
  '/project/check.mjs':`import assert from 'node:assert/strict';import {message} from './message.js';assert.equal(message,process.argv[2]);console.log('MESSAGE_TEST_PASSED '+message);`,
  '/project/server.mjs':`import {createServer} from 'vite';const server=await createServer({server:{host:'127.0.0.1',port:8521,strictPort:true}});await server.listen();console.log('VITE_READY');`,
})
let owner:Server,host:Server,ownerURL:string,previewOrigin:string
const serverCompilerWorkers:string[]=[]
const listen=async(server:Server)=>{await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));return `http://127.0.0.1:${(server.address() as {port:number}).port}`}
test.beforeAll(async()=>{
  split=await prepareStrictSplitAssets(root,runtimeRoot)
  owner=createServer((req,res)=>{
    if(split){res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp')}
    const path=new URL(req.url!,'http://localhost').pathname
    if(path.endsWith('/workers/browser-compiler.js'))serverCompilerWorkers.push(path)
    if(path==='/app/'){res.setHeader('Content-Type','text/html');res.end('<div id="preview"></div><script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk;</script>');return}
    try{if(!path.startsWith('/app/vendor/'))throw Error('outside package');const file=strictSDKFile(root,split?.directory,decodeURIComponent(path.slice('/app/vendor/'.length)));res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
  })
  host=createServer((req,res)=>{const path=new URL(req.url!,'http://localhost').pathname,route=hosting.routes.find((row:any)=>row.path===path&&row.method===req.method);if(!route){res.writeHead(hosting.fallbackStatus,hosting.fallbackHeaders??{});res.end();return}res.writeHead(200,route.headers);res.end(readFileSync(resolve(split?.previewHostDirectory??resolve(root,'preview-host'),route.file)))})
  ownerURL=await listen(owner)+'/app/';previewOrigin=await listen(host)
})
test.afterAll(async()=>{for(const server of [owner,host])await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

test('Vite 7 cold registry install, edit, test, HMR and offline workspace resume',async({page,context},info)=>{
  test.setTimeout(240000)
  let resume=false
  const registry:string[]=[],resumeExternalRequests:string[]=[],rounds:unknown[]=[],errors:string[]=[]
  const registryTransfers:{url:string;event:string;status?:number;error?:string}[]=[]
  context.on('response',response=>{if(new URL(response.url()).hostname==='registry.npmjs.org')registryTransfers.push({url:response.url(),event:'headers',status:response.status()})})
  context.on('requestfinished',request=>{if(new URL(request.url()).hostname==='registry.npmjs.org')registryTransfers.push({url:request.url(),event:'finished'})})
  context.on('requestfailed',request=>{if(new URL(request.url()).hostname==='registry.npmjs.org')registryTransfers.push({url:request.url(),event:'failed',error:request.failure()?.errorText})})
  const compilerWorkers:string[]=[]
  context.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/workers/browser-compiler.js'))compilerWorkers.push(request.url())})
  context.on('request',request=>{const url=new URL(request.url());if(resume&&![new URL(ownerURL).origin,previewOrigin].includes(url.origin))resumeExternalRequests.push(url.href);if(url.hostname==='registry.npmjs.org')registry.push(url.href)})
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(ownerURL);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const engines=observeSDKEngines(page,info,root,'quickjs-als-wasm',[],[],split)
  let failure:unknown
  try{
    for(const restored of [false,true]){
      resume=restored
      if(resume){
        // Match only external traffic so local preview/service-worker routing is untouched.
        await context.route(url=>['http:','https:'].includes(url.protocol)&&![new URL(ownerURL).origin,previewOrigin].includes(url.origin),route=>route.abort())
        await page.reload();await page.waitForFunction(()=>Boolean((window as any).sdk));expect(await page.evaluate(()=>Boolean((window as any).viteSDK))).toBe(false)
      }
      const started=Date.now()
      await page.evaluate(async({files,previewOrigin,resume,nativeCompiler})=>{
        const {AgentSession,WorkerHTTP,WorkerWebSocket,URLPreview}=(window as any).sdk
        const state:any=(window as any).viteSDK={logs:[],tests:[]}
        // Vite and its compiler each reserve this ceiling. Leave room for
        // concurrent checks under the unchanged 512 MiB aggregate budget.
        const session=state.session=new AgentSession(resume?{}:files,{assetBaseURL:new URL('/app/vendor/runtime/',location.href).href,cooperative:false,maxBytes:128*1024*1024,workspace:{maxBytes:128*1024*1024},...(nativeCompiler?{experimentalCompiler:{maxMemoryPages:1024,timeoutMs:30000,lifetime:'session'}}:{})}),kernel=session.kernel
        state.timer=setTimeout(()=>{state.deadline=true;state.preview?.close();session.close()},120000)
        state.store=async(value?:unknown)=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open('sdk-vite7-resume',1);req.onupgradeneeded=()=>req.result.createObjectStore('workspace');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});try{return await new Promise<any>((resolve,reject)=>{const tx=db.transaction('workspace',value===undefined?'readonly':'readwrite'),table=tx.objectStore('workspace'),req=value===undefined?table.get('project'):table.put(value,'project');tx.oncomplete=()=>resolve(req.result);tx.onabort=()=>reject(tx.error)})}finally{db.close()}}
        if(resume){const saved=await state.store();if(!saved)throw Error('Missing snapshot');await session.restore({snapshot:saved});const actual=await session.snapshot();const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;if(JSON.stringify(canonical(saved))!==JSON.stringify(canonical(actual)))throw Error('Snapshot differs after restore');state.byteExactRestore=true;state.install={skipped:true}}else state.install=await session.install({options:{cwd:'/project',ignoreScripts:true}})
        state.check=async(expected:string)=>{const result=await session.run({command:'node',args:['check.mjs',expected],cwd:'/project'});state.tests.push(result);return result}
        const initial=await state.check(resume?'Edited message':'Original message');if(initial.status!==0||!initial.stdout.includes('MESSAGE_TEST_PASSED'))throw Error('Initial test failed: '+JSON.stringify(initial))
        const child=state.child=await kernel.spawn('node',['server.mjs'],{cwd:'/project',guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:128*1024*1024,timeoutMs:30000})
        let output='';for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr'){const text=new TextDecoder().decode(event.bytes);state.logs.push(text);output+=text}if(output.includes('VITE_READY'))break;if(!event||event.type==='exit')throw Error('Vite startup failed: '+output)}
        state.drain=(async()=>{try{for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr'){if(state.logs.length<1000)state.logs.push(new TextDecoder().decode(event.bytes))}else break}}catch(error){state.logs.push(String(error))}})()
        const http=new WorkerHTTP(kernel,8521)
        state.preview=await URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:http,connectWebSocket:(url:string,protocols:string[])=>WorkerWebSocket.connect(kernel,8521,previewOrigin,url,protocols)})
      },{files,previewOrigin,resume,nativeCompiler})
      const frame=page.frameLocator('#preview iframe')
      await expect(frame.locator('#message')).toHaveText(resume?'Edited message':'Original message',{timeout:60000})
      await frame.locator('#count').click();await expect(frame.locator('#count')).toHaveText('1')
      await frame.locator('body').evaluate(()=>{(window as any).viteDocument='retained'})
      const checks=await page.evaluate(async resume=>{const state=(window as any).viteSDK;const failed=await state.check('wrong expectation');await state.session.write({path:'/project/message.js',text:`export const message = ${JSON.stringify(resume?'Resumed message':'Edited message')};\n`});const passed=await state.check(resume?'Resumed message':'Edited message');return {failed,passed}},resume)
      expect(checks.failed.status).not.toBe(0);expect(checks.failed.stderr).toContain('AssertionError');expect(checks.passed.status).toBe(0);expect(checks.passed.stdout.trim()).toBe('MESSAGE_TEST_PASSED '+(resume?'Resumed message':'Edited message'))
      await expect(frame.locator('#message')).toHaveText(resume?'Resumed message':'Edited message')
      await expect(frame.locator('#count')).toHaveText('1');expect(await frame.locator('body').evaluate(()=>(window as any).viteDocument)).toBe('retained')
      const evidence=await page.evaluate(async resume=>{const state=(window as any).viteSDK;state.preview.close();await state.child.dispose();await state.drain;const resources=await state.session.resources();const snapshot:any=await state.session.snapshot();if(!resume)await state.store(snapshot);clearTimeout(state.timer);const shutdown=await state.session.close();return {resume,install:state.install,byteExactRestore:state.byteExactRestore,shutdown,resources,tests:state.tests,logs:state.logs,files:Object.keys(snapshot.files),deadline:!!state.deadline}},resume)
      expect(evidence.shutdown).toEqual({closed:true})
      rounds.push(evidence);expect(evidence.resources.processes).toEqual({active:0,retained:0});expect(evidence.resources.network).toEqual({handles:0,listeners:0,details:[]});expect(evidence.deadline).toBe(false);expect(Date.now()-started).toBeLessThan(120000)
      if(resume)expect(evidence.byteExactRestore).toBe(true);else{expect(evidence.install.installed).toBeGreaterThan(0);expect(registry.some(url=>url.includes('.tgz'))).toBe(true)}
      expect(resumeExternalRequests).toEqual([]);await expect(page.locator('iframe')).toHaveCount(0)
      if(nativeCompiler)expect(serverCompilerWorkers.length).toBeGreaterThanOrEqual(resume?2:1)
    }
    expect(errors,'Vite workflow must not hide owner page errors').toEqual([])
  }catch(error){failure=error;throw error}finally{
    const final=await page.evaluate(async()=>{const state=(window as any).viteSDK;if(!state)return null;clearTimeout(state.timer);state.preview?.close();let resources,shutdown;try{await state.child?.dispose();await state.drain;resources=await state.session.resources()}catch(error){resources={error:String(error)}}finally{shutdown=await state.session.close()}return {resources,shutdown,logs:state.logs,tests:state.tests,deadline:state.deadline}}).catch(error=>({error:String(error)}))
    const path=info.outputPath('sdk-vite7-resume.json')
    await writeFile(path,JSON.stringify({...split?.evidence,failure:failure instanceof Error?{name:failure.name,message:failure.message,stack:failure.stack}:failure,nativeCompiler,compilerWorkers,serverCompilerWorkers,commands:{install:'AgentSession.install({cwd:"/project",ignoreScripts:true})',test:'node check.mjs <expected>',server:'node server.mjs'},lockfileSHA256:createHash('sha256').update(files['/project/package-lock.json']).digest('hex'),rounds,registry,registryTransfers,resumeExternalRequests,errors,final},null,2))
    await info.attach('sdk-vite7-resume.json',{path,contentType:'application/json'})
    try{await engines.flush()}catch(error){if(!failure)throw error}
  }
})
