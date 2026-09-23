import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'
import {createHash} from 'node:crypto'
import {observeSDKEngines} from '../sdk/engine-evidence'
import {exampleEnginePolicy} from '../../examples/sdk-frameworks/engine-policy.mjs'

const root=realpathSync(process.env.SDK_OUTPUT!)
const sdkManifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const engine=exampleEnginePolicy(sdkManifest)
const svelteEngine=sdkManifest.buildProfile.endsWith('-cooperative-heap-loops')?{cooperative:true}:engine.options
const hosting=JSON.parse(readFileSync(resolve(root,'preview-host/hosting.json'),'utf8'))
const names=['package.json','package-lock.json','vite.config.js','svelte.config.js','src/app.html','src/routes/+page.server.js','src/routes/+page.svelte','src/routes/api/+server.js']
const files=Object.fromEntries(names.map(name=>['/project/'+name,readFileSync('fixtures/install-sveltekit-wasm/'+name,'utf8')]))
let owner:Server,previewHost:Server,ownerURL:string,previewOrigin:string
const serverEngineLoads:{url:string;slot:string;path:string;status:number;bytes:number;sha256:string}[]=[]
const listen=async(server:Server)=>{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`
}
test.beforeAll(async()=>{
  owner=createServer((req,res)=>{
    if(engine.requiresIsolation){
      res.setHeader('Cross-Origin-Opener-Policy','same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    }
    const path=new URL(req.url!,'http://localhost').pathname
    if(path==='/app/'){
      res.setHeader('Content-Type','text/html')
      res.end('<div id="preview"></div><script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk;</script>');return
    }
    try{
      if(!path.startsWith('/app/vendor/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice('/app/vendor/'.length))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      const bytes=readFileSync(file)
      const enginePath=path.match(/\/app\/vendor\/(runtime\/([^/]+)\/engine\.wasm)$/)
      if(enginePath)serverEngineLoads.push({url:`http://${req.headers.host}${path}`,path:enginePath[1],slot:enginePath[2],status:200,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
      res.end(bytes)
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
test.afterAll(async()=>{
  for(const server of [owner,previewHost])if(server)await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))
})

test('built SDK installs SvelteKit and serves SSR, hydration, server requests and same-document HMR',async({page,request},info)=>{
  const diagnostics:string[]=[],requests:string[]=[]
  page.on('pageerror',error=>diagnostics.push(error.message))
  page.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text())})
  page.on('request',request=>requests.push(request.url()))
  expect((await request.get(previewOrigin+'/')).status()).toBe(503)
  await page.goto(ownerURL)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const engineEvidence=observeSDKEngines(page,info,root,'cooperative' in svelteEngine&&svelteEngine.cooperative?'quickjs-als-asyncify-wasm-cooperative':'experimentalFibers' in engine.options?'quickjs-als-asyncify-wasm-atomics-fibers-shared-storage':'quickjs-als-wasm',[],serverEngineLoads)
  try{
    await page.evaluate(async({files,previewOrigin,svelteEngine})=>{
      const {WorkerKernel,WorkerHTTP,WorkerWebSocket,URLPreview}=(window as any).sdk
      const state:any=(window as any).svelteSDK={stage:'install',logs:[],ssr:[]}
      const kernel=state.kernel=new WorkerKernel(files,{...svelteEngine,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
      state.install=await kernel.install({cwd:'/project',ignoreScripts:true})
      await kernel.writeText('/project/server.mjs',`import {createServer} from 'vite';const server=await createServer({server:{host:'127.0.0.1',port:8517,strictPort:true}});await server.listen();console.log('SVELTE_READY');`)
      state.stage='spawn'
      const child=state.child=await kernel.spawn('node',['server.mjs'],{cwd:'/project',lifetime:'session',guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000})
      let output=''
      for(;;){
        const event=await child.next()
        if(event?.type==='stdout'||event?.type==='stderr'){
          const text=new TextDecoder().decode(event.bytes);output+=text;state.logs.push(text)
        }
        if(output.includes('SVELTE_READY'))break
        if(!event||event.type==='exit')throw Error('SvelteKit startup failed: '+output)
      }
      void(async()=>{try{for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr'){if(state.logs.length<300)state.logs.push(new TextDecoder().decode(event.bytes))}else break}}catch(error){state.logs.push(String(error))}})()
      state.stage='preview'
      const http=new WorkerHTTP(kernel,8517)
      try{
        state.preview=await URLPreview.mount(document.querySelector('#preview'),{
          origin:previewOrigin,
          server:{fetch:async(request:Request)=>{
            const response=await http.fetch(request)
            if(request.method==='GET'&&new URL(request.url).pathname==='/'){
              state.ssr.push({status:response.status,contentType:response.headers.get('content-type'),html:await response.clone().text()})
            }
            return response
          }},
          connectWebSocket:(url:string,protocols:string[])=>WorkerWebSocket.connect(kernel,8517,previewOrigin,url,protocols),
        })
      }catch(error){
        const response=state.ssr.at(-1)
        throw Error(String(error)+(response?`\nSSR ${response.status}: ${response.html.slice(0,4000)}`:''))
      }
      state.stage='mounted'
    },{files,previewOrigin,svelteEngine})
    const ssr=await page.evaluate(()=>(window as any).svelteSDK.ssr[0])
    expect(ssr?.status).toBe(200)
    expect(ssr.html).toContain('Installed SvelteKit')
    expect(ssr.html).toContain('SvelteKit server loader ran')
    expect(ssr.html).toContain('data-hydrated="false"')
    const preview=page.frameLocator('#preview iframe')
    await expect(preview.locator('h1')).toHaveText('Installed SvelteKit',{timeout:60000})
    await expect(preview.locator('main')).toHaveAttribute('data-hydrated','true',{timeout:60000})
    await expect(preview.locator('p')).toHaveText('SvelteKit server loader ran')
    await preview.locator('#count').click()
    await expect(preview.locator('#count')).toHaveText('Count: 1')
    await preview.locator('#request').click()
    await expect(preview.locator('#reply')).toHaveText('{"method":"POST","answer":42}')
    const frame=page.frames().find(frame=>frame.url()===previewOrigin+'/')!
    await frame.evaluate(()=>(window as any).hmrDocumentMarker='same-document')
    await page.evaluate(async()=>{
      const state=(window as any).svelteSDK;state.stage='edit'
      const path='/project/src/routes/+page.svelte'
      await state.kernel.writeText(path,(await state.kernel.readText(path)).replace('Installed SvelteKit','Edited SvelteKit'))
    })
    await expect(preview.locator('h1')).toHaveText('Edited SvelteKit')
    // The pinned native Svelte HMR control recreates component-local state.
    await expect(preview.locator('#count')).toHaveText('Count: 0')
    expect(await frame.evaluate(()=>(window as any).hmrDocumentMarker)).toBe('same-document')
    await preview.locator('#count').click()
    await expect(preview.locator('#count')).toHaveText('Count: 1')
    expect(await frame.evaluate(()=>{try{void parent.document.body;return false}catch{return true}})).toBe(true)
    const ownerOrigin=new URL(ownerURL).origin
    expect(requests.filter(url=>url.startsWith(ownerOrigin+'/')&&!url.startsWith(ownerURL))).toEqual([])
    expect(diagnostics.filter(message=>/WebSocket|websocket|vite.*failed to connect/i.test(message))).toEqual([])
    await info.attach('sdk-sveltekit-preview.png',{body:await page.screenshot(),contentType:'image/png'})
  }finally{
    try{
      await info.attach('sdk-sveltekit-diagnostics.json',{body:JSON.stringify({diagnostics,requests,state:await page.evaluate(()=>{
        const state=(window as any).svelteSDK
        return {stage:state?.stage,install:state?.install,logs:state?.logs,ssr:state?.ssr,previewRequests:state?.preview?.requests,previewDiagnostics:state?.preview?.diagnostics}
      })}),contentType:'application/json'})
    }finally{
      try{await page.evaluate(()=>{const state=(window as any).svelteSDK;state?.preview?.close();state?.kernel?.close()})}
      finally{await engineEvidence.flush()}
    }
  }
  await expect(page.locator('iframe')).toHaveCount(0)
})
