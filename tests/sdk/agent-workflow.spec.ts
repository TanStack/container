import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'

const sdkRoot=realpathSync(process.env.SDK_OUTPUT!)
const hosting=JSON.parse(readFileSync(resolve(sdkRoot,'preview-host/hosting.json'),'utf8'))
const policy={maxBytes:128*1024*1024,timeoutMs:15000}
const files:Record<string,string>=Object.fromEntries(['package.json','package-lock.json','packages/app/package.json','packages/shared/package.json'].map(path=>['/'+path,readFileSync('fixtures/workspace-lock/'+path,'utf8')]))
Object.assign(files,{
 '/packages/app/index.js':'module.exports=require("@probe/shared")+2',
 '/packages/shared/index.js':'module.exports=39',
 '/test.cjs':'const assert=require("node:assert/strict");assert.equal(require("@probe/app"),42);console.log("assert passed")',
 '/server.cjs':`const http=require('node:http');const answer=require('@probe/app');let clicks=0;http.createServer((req,res)=>{if(req.url==='/increment'){res.end(String(answer+(++clicks)));return}res.setHeader('content-type','text/html');res.end('<html><head><title>Workspace preview</title></head><body><p id="answer">'+answer+'</p><button id="increment">increment</button><output id="result"></output><script>document.querySelector("#increment").onclick=async()=>{document.querySelector("#result").textContent=await(await fetch("/increment",{method:"POST"})).text()}</script></body></html>')}).listen(8527,()=>console.log('READY'))`,
})
let owner:Server,previewHost:Server,ownerURL:string,previewOrigin:string
test.beforeAll(async()=>{
 owner=createServer((req,res)=>{
  const path=new URL(req.url!,'http://localhost').pathname
  if(path==='/app/'){res.setHeader('content-type','text/html');res.end('<div id="preview"></div><script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk</script>');return}
  try{if(!path.startsWith('/app/vendor/'))throw Error();const file=realpathSync(resolve(sdkRoot,decodeURIComponent(path.slice('/app/vendor/'.length))));if(!file.startsWith(sdkRoot+sep))throw Error();res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm'} as Record<string,string>)[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
 })
 previewHost=createServer((req,res)=>{const path=new URL(req.url!,'http://localhost').pathname,route=hosting.routes.find((item:any)=>item.path===path&&item.method===req.method);if(!route){res.writeHead(hosting.fallbackStatus);res.end();return}res.writeHead(200,route.headers);res.end(readFileSync(resolve(sdkRoot,'preview-host',route.file)))})
 const listen=async(server:Server)=>{await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));return `http://127.0.0.1:${(server.address() as {port:number}).port}`}
 ownerURL=await listen(owner)+'/app/';previewOrigin=await listen(previewHost)
})
test.afterAll(async()=>{for(const server of [owner,previewHost])if(server)await new Promise<void>(done=>server.close(()=>done()))})

test('packaged offline install edit test preview and host-saved workspace resume',async({page,context},info)=>{
 test.setTimeout(60000)
 const registry:string[]=[],evidence:any={policy,persistence:'Host-owned IndexedDB workspace snapshot, not process state',rounds:[]}
 await context.route('https://registry.npmjs.org/**',route=>{registry.push(route.request().url());return route.abort()})
 try{
  for(const resume of [false,true]){
   if(resume)await page.reload();else await page.goto(ownerURL)
   await page.waitForFunction(()=>Boolean((window as any).sdk))
   const result=await page.evaluate(async({files,policy,resume,previewOrigin})=>{
    const {AgentSession,WorkerHTTP,URLPreview}=(window as any).sdk
    // The embedding application owns durable storage. The SDK owns snapshot format.
    const store=async(operation:'load'|'save'|'delete',value?:unknown)=>{
     const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('sdk-workflow-host',1);request.onupgradeneeded=()=>request.result.createObjectStore('workspaces');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
     try{return await new Promise<any>((resolve,reject)=>{const tx=db.transaction('workspaces',operation==='load'?'readonly':'readwrite'),table=tx.objectStore('workspaces'),request=operation==='load'?table.get('project'):operation==='save'?table.put(value,'project'):table.delete('project');tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error)})}finally{db.close()}
    }
    const session=new AgentSession(resume?{}:files,policy),state:any=(window as any).workflow={session,store}
    const result:any={resume}
    if(resume){const snapshot=await store('load');if(!snapshot)throw Error('Missing host checkpoint');await session.restore({snapshot});result.restoredSource=await session.read({path:'/packages/shared/index.js'})}
    else{result.install=await session.install();result.before=await session.run({command:'node',args:['/test.cjs']});await session.write({path:'/packages/shared/index.js',text:'module.exports=40'})}
    result.test=await session.run({command:'node',args:['/test.cjs']})
    state.child=await session.kernel.spawn('node',['/server.cjs'],{lifetime:'session',timeoutMs:15000,maxBytes:policy.maxBytes})
    let output='';for(;;){const event=await state.child.next();if(event?.type==='stdout'||event?.type==='stderr')output+=new TextDecoder().decode(event.bytes);if(output.includes('READY'))break;if(!event||event.type==='exit')throw Error('Server failed: '+output)}
    state.preview=await URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:new WorkerHTTP(session.kernel,8527)})
    return result
   },{files,policy,resume,previewOrigin})
   evidence.rounds.push(result)
   if(!resume){expect(result.install.installed).toBeGreaterThan(0);expect(result.before.status).not.toBe(0)}else expect(result.restoredSource).toEqual({text:'module.exports=40'})
   expect(result.test).toMatchObject({status:0,stdout:'assert passed\n',truncated:false})
   const frame=page.frameLocator('#preview iframe');await expect(frame.locator('#answer')).toHaveText('42');await frame.locator('#increment').click();await expect(frame.locator('#result')).toHaveText('43')
   result.cleanup=await page.evaluate(async(resume)=>{const state=(window as any).workflow;state.preview.close();await state.child.dispose();const resources=await state.session.resources();if(!resume)await state.store('save',await state.session.snapshot());else await state.store('delete');state.session.close();delete (window as any).workflow;return resources},resume)
   expect(result.cleanup.processes.active).toBe(0);expect(result.cleanup.network.handles).toBe(0)
  }
  expect(registry).toEqual([])
 }finally{
  evidence.registry=registry
  try{await page.evaluate(async()=>{const state=(window as any).workflow;if(state){state.preview?.close();try{await state.child?.dispose()}finally{state.session.close();await state.store('delete')}}})}catch(error){evidence.cleanupError=String(error)}
  const path=info.outputPath('agent-workflow.json');await writeFile(path,JSON.stringify(evidence,null,2));await info.attach('agent-workflow.json',{path,contentType:'application/json'})
 }
})
