import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const hosting=JSON.parse(readFileSync(resolve(root,'preview-host/hosting.json'),'utf8'))
const policy={experimentalFibers:true,maxBytes:128*1024*1024,workerMaxBytes:64*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let owner,previewHost,ownerURL,previewOrigin,snapshot,preparation
async function listen(server){await new Promise(done=>server.listen(0,'127.0.0.1',done));return `http://127.0.0.1:${server.address().port}`}
test.beforeAll(async()=>{
 const closure=await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['vite','@rolldown/binding-wasm32-wasi']);snapshot=JSON.stringify(closure);preparation=closure.preparation
 owner=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname
  if(path==='/'){res.setHeader('content-type','text/html');res.end('<div id="preview"></div><script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
  if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
  try{if(!path.startsWith('/sdk/'))throw Error();const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))));if(!file.startsWith(root+sep))throw Error();res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
 })
 previewHost=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname,route=hosting.routes.find(item=>item.path===path&&item.method===req.method);if(!route){res.writeHead(hosting.fallbackStatus);res.end();return}res.writeHead(200,route.headers);res.end(readFileSync(resolve(root,'preview-host',route.file)))})
 ownerURL=await listen(owner);previewOrigin=await listen(previewHost)
})
test.afterAll(async()=>{for(const server of [owner,previewHost])if(server)await new Promise(done=>server.close(done))})

test('AgentSession Vite HMR survives host reload through an offline workspace snapshot',async({page,context},info)=>{
 test.setTimeout(60000)
 const diagnostics=process.env.VITE_DIAGNOSTICS==='1'
 let offline=false,workflowError
 const registry=[],fixtureRequests=[],messages=[],rounds=[]
 const requests=[],requestIDs=new WeakMap(),requestStarted=performance.now()
 let nextRequest=0,requestEventsDropped=0
 const traceRequest=(phase,request,extra={})=>{
  if(!request.url().startsWith(previewOrigin+'/'))return
  if(!requestIDs.has(request))requestIDs.set(request,++nextRequest)
  if(requests.length>=192){requestEventsDropped++;return}
  const url=new URL(request.url())
  requests.push({resume:offline,phase,id:requestIDs.get(request),path:url.pathname+url.search,type:request.resourceType(),ms:performance.now()-requestStarted,...extra})
 }
 page.on('request',request=>traceRequest('request',request))
 page.on('response',response=>traceRequest('response',response.request(),{status:response.status()}))
 page.on('requestfailed',request=>traceRequest('failed',request,{error:request.failure()?.errorText}))
 await context.route('https://registry.npmjs.org/**',route=>{registry.push(route.request().url());return route.abort()})
 await context.route(ownerURL+'/fixture.json',route=>{fixtureRequests.push({resume:offline});return offline?route.abort():route.continue()})
 page.on('console',message=>{if(messages.length<200)messages.push({type:message.type(),text:message.text().slice(0,2000)})})
 page.on('pageerror',error=>{if(messages.length<200)messages.push({type:'pageerror',text:error.message.slice(0,2000)})})
 try{
  for(const resume of [false,true]){
   const messageStart=messages.length
   if(resume){offline=true;await page.reload()}else await page.goto(ownerURL)
   await page.waitForFunction(()=>!!window.sdk)
   await page.evaluate(async({resume,policy,previewOrigin,diagnostics})=>{
    const {AgentSession,WorkerHTTP,WorkerWebSocket,URLPreview}=window.sdk
    const store=async(operation,value)=>{
     const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('agent-vite-resume',1);request.onupgradeneeded=()=>request.result.createObjectStore('snapshots');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
     try{return await new Promise((resolve,reject)=>{const tx=db.transaction('snapshots',operation==='load'?'readonly':'readwrite'),table=tx.objectStore('snapshots'),request=operation==='load'?table.get('project'):operation==='save'?table.put(value,'project'):table.delete('project');tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error)})}finally{db.close()}
    }
    let files={}
    if(!resume){const closure=await fetch('/fixture.json').then(response=>{if(!response.ok)throw Error('Missing fixture');return response.json()});files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))}
    const session=new AgentSession(files,policy),state=window.agentVite={session,store,resume,output:'',cleanup:[],deadline:false,startedAt:performance.now()}
    state.initialPaths=new Set(Object.keys(files))
    state.httpRequests=[];state.httpRequestsDropped=0
    state.failureEvidence=()=>({workerStartFailures:session.kernel.workerStartFailures,workerStartFailuresDropped:session.kernel.workerStartFailuresDropped,httpRequests:state.httpRequests,httpRequestsDropped:state.httpRequestsDropped})
    state.timer=setTimeout(()=>{state.deadline=true;session.kernel.close(new Error('Agent Vite round deadline'))},15000)
    const call=async(name,input={})=>{const result=await session.call(name,input);if(!result.ok)throw Error(JSON.stringify(result.error));return result.value}
    state.call=call
    if(resume){const saved=await store('load');if(!saved)throw Error('Missing saved workspace');await call('restore',{snapshot:saved});state.restored=await call('read',{path:'/project/app/message.ts'})}
    else{
     const app={
      '/project/app/index.html':'<html><head><title>Agent Vite preview</title></head><body><button id="count"></button><p id="message"></p><script type="module" src="/main.ts"></script></body></html>',
      '/project/app/message.ts':'export const message: string = "first version";',
      '/project/app/main.ts':`import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.onclick=()=>button.textContent=String(++count);document.querySelector('#message').textContent=message;if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);`,
      '/project/server.mjs':`import {createServer} from 'vite';const server=await createServer({root:'/project/app',configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:8524,strictPort:true}});await server.listen();console.log('VITE_READY');`,
     }
     for(const [path,text]of Object.entries(app))await call('write',{path,text})
    }
    state.child=await session.kernel.spawn('node',['/project/server.mjs'],{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:'/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'},lifetime:'session',guestWasm:true,webAPIs:true,diagnostics,maxBytes:policy.maxBytes,timeoutMs:15000})
    const append=event=>{if(event?.type==='stdout'||event?.type==='stderr')state.output+=(new TextDecoder().decode(event.bytes)).slice(0,Math.max(0,32768-state.output.length))}
    for(;;){const event=await state.child.next();append(event);if(state.output.includes('VITE_READY'))break;if(!event||event.type==='exit')throw Error('Vite did not start: '+state.output)}
    state.drain=(async()=>{for(;;){const event=await state.child.next();append(event);if(!event||event.type==='exit')break}})().catch(error=>{state.drainError=String(error)})
    const http=new WorkerHTTP(session.kernel,8524)
    const server=diagnostics?{async fetch(request){
     const url=new URL(request.url),entry={path:url.pathname+url.search,ms:performance.now()-state.startedAt}
     if(state.httpRequests.length<96)state.httpRequests.push(entry);else state.httpRequestsDropped++
     try{const response=await http.fetch(request);entry.status=response.status;entry.headersMs=performance.now()-state.startedAt;return response}
     catch(error){entry.error=String(error).slice(0,500);entry.failedMs=performance.now()-state.startedAt;throw error}
    }}:http
    state.preview=await URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server,connectWebSocket:(url,protocols)=>WorkerWebSocket.connect(session.kernel,8524,previewOrigin,url,protocols)})
   },{resume,policy,previewOrigin,diagnostics})
   const frame=page.frameLocator('#preview iframe'),initial=resume?'second version':'first version',updated=resume?'third version':'second version'
   await expect(frame.locator('#message')).toHaveText(initial)
   await expect(frame.locator('#count')).toHaveText('42');await frame.locator('#count').click();await expect(frame.locator('#count')).toHaveText('43')
   await expect.poll(()=>messages.slice(messageStart).some(message=>message.text.includes('[vite] connected.'))).toBe(true)
   const marker=await frame.locator('body').evaluate(()=>{window.__agentHmrMarker='same-document';return window.__agentHmrMarker})
   await page.evaluate(async updated=>{await window.agentVite.call('write',{path:'/project/app/message.ts',text:`export const message: string = "${updated}";`})},updated)
   await expect(frame.locator('#message')).toHaveText(updated);await expect(frame.locator('#count')).toHaveText('43');expect(await frame.locator('body').evaluate(()=>window.__agentHmrMarker)).toBe(marker)
   const round=await page.evaluate(async resume=>{
    const state=window.agentVite;state.preview.close();await state.child.dispose();await state.drain
    const resources=await state.session.resources()
    const elapsedMs=performance.now()-state.startedAt;clearTimeout(state.timer)
    const persistenceStarted=performance.now()
    if(!resume){
     const captured=await state.call('snapshot'),paths=Object.keys(captured.files),created=paths.filter(path=>!state.initialPaths.has(path)).sort()
     const fileBytes=Object.values(captured.files).reduce((sum,value)=>sum+value.base64.length*3/4-(value.base64.endsWith('==')?2:value.base64.endsWith('=')?1:0),0)
     state.snapshotEvidence={files:paths.length,fileBytes,newFiles:created.length,newPaths:created.slice(0,64),newPathsTruncated:Math.max(0,created.length-64)}
     await state.store('save',JSON.parse(JSON.stringify(captured)))
    }else await state.store('delete')
    const evidence={resume,resources,restored:state.restored,output:state.output,drainError:state.drainError,deadline:state.deadline,elapsedMs,persistenceMs:performance.now()-persistenceStarted,snapshot:state.snapshotEvidence,...state.failureEvidence()}
    state.session.close();delete window.agentVite;return evidence
   },resume)
   rounds.push(round);expect(round.deadline).toBe(false);expect(round.elapsedMs).toBeLessThan(15000);expect(round.drainError).toBeUndefined();expect(round.resources.processes.active).toBe(0);expect(round.resources.network.handles).toBe(0)
   expect(round.resources.processes.retained).toBe(0);expect(round.resources.network.listeners).toBe(0)
   if(resume)expect(round.restored).toEqual({text:'export const message: string = "second version";'})
  }
  expect(registry).toEqual([]);expect(fixtureRequests).toEqual([{resume:false}])
 }catch(error){workflowError=String(error);throw error}
 finally{
  let failureCleanup
  try{failureCleanup=await page.evaluate(async()=>{const state=window.agentVite;if(!state)return null;clearTimeout(state.timer);try{state.preview?.close()}catch(error){state.cleanup.push(String(error))}try{await state.child?.dispose();await state.drain}catch(error){state.cleanup.push(String(error))}try{state.resources=await state.session.resources()}catch(error){state.cleanup.push(String(error))}try{await state.store('delete')}catch(error){state.cleanup.push(String(error))}try{state.session.close()}catch(error){state.cleanup.push(String(error))}return {resume:state.resume,deadline:state.deadline,elapsedMs:performance.now()-state.startedAt,output:state.output,drainError:state.drainError,resources:state.resources,cleanup:state.cleanup,snapshot:state.snapshotEvidence,...state.failureEvidence()}})}catch(error){failureCleanup={error:String(error)}}
  const path=info.outputPath('agent-vite-resume.json');await writeFile(path,JSON.stringify({sdk:root,policy,diagnostics,preparation,scope:'Staged complete Vite closure, not registry installation; workspace snapshot restore, not running-process restore',workflowError,registry,fixtureRequests,messages,requests,requestEventsDropped,rounds,failureCleanup},null,2));await info.attach('agent-vite-resume.json',{path,contentType:'application/json'})
 }
})
