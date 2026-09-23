import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'

const root=realpathSync(process.env.SDK_OUTPUT!)
const hosting=JSON.parse(readFileSync(resolve(root,'preview-host/hosting.json'),'utf8'))
const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/'+name,readFileSync('fixtures/install-start-wasm/'+name,'utf8')]))
let owner:Server,previewHost:Server,ownerURL:string,previewOrigin:string
const listen=async(server:Server)=>{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`
}
test.beforeAll(async()=>{
  owner=createServer((req,res)=>{
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

for(const projectRoot of ['/project'])test(`built SDK installs and runs Vite with isolated preview, counter-preserving HMR and explicit reload at ${projectRoot}`,async({page,request},info)=>{
  const diagnostics:string[]=[],requests:string[]=[]
  page.on('pageerror',error=>diagnostics.push(error.message))
  page.on('console',message=>{if(message.type()==='error'||message.text().startsWith('HMR trace:'))diagnostics.push(message.text())})
  page.on('request',request=>requests.push(request.url()))
  expect((await request.get(previewOrigin+'/')).status()).toBe(503)
  await page.goto(ownerURL)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  try{
    await page.evaluate(async({files,previewOrigin,projectRoot})=>{
      const {WorkerKernel,WorkerHTTP,WorkerWebSocket,URLPreview}=(window as any).sdk
      const prefix=projectRoot==='/'?'':projectRoot
      const state:any=(window as any).viteSDK={logs:[],stage:'install',projectRoot}
      const kernel=state.kernel=new WorkerKernel(Object.fromEntries(Object.entries(files).map(([path,value])=>[prefix+path,value])),{maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
      state.install=await kernel.install({ignoreScripts:true,cwd:projectRoot})
      await kernel.writeText(prefix+'/index.html','<html><head><title>SDK Vite</title></head><body><button id="count"></button><p id="message"></p><script type="module" src="/main.ts"></script></body></html>')
      await kernel.writeText(prefix+'/message.ts','export const message: string = "first version";')
      await kernel.writeText(prefix+'/main.ts',`import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.addEventListener('click',()=>button.textContent=String(++count));document.querySelector('#message').textContent=message;if(import.meta.hot){import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);for(const event of ['vite:beforeUpdate','vite:beforeFullReload','vite:invalidate'])import.meta.hot.on(event,payload=>console.debug('HMR trace:',event,JSON.stringify(payload)));}`)
      await kernel.writeText(prefix+'/server.mjs',`import {createServer} from 'vite';
        const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:8514,strictPort:true}});
        server.watcher.on('all',(event,path)=>console.log('WATCH',event,path));
        await server.listen();console.log('VITE_READY');`)
      state.stage='spawn'
      const child=state.child=await kernel.spawn('node',['server.mjs'],{cwd:projectRoot,lifetime:'session',guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000})
      let output=''
      for(;;){
        const event=await child.next()
        if(event?.type==='stdout'||event?.type==='stderr'){
          const text=new TextDecoder().decode(event.bytes);output+=text;state.logs.push(text)
        }
        if(output.includes('VITE_READY'))break
        if(!event||event.type==='exit')throw Error('Vite startup failed: '+output)
      }
      void(async()=>{try{for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr'){if(state.logs.length<200)state.logs.push(new TextDecoder().decode(event.bytes))}else break}}catch(error){state.logs.push(String(error))}})()
      state.stage='preview'
      state.preview=await URLPreview.mount(document.querySelector('#preview'),{
        origin:previewOrigin,server:new WorkerHTTP(kernel,8514),
        connectWebSocket:(url:string,protocols:string[])=>WorkerWebSocket.connect(kernel,8514,previewOrigin,url,protocols),
      })
      state.stage='mounted'
    },{files,previewOrigin,projectRoot})
    const preview=page.frameLocator('#preview iframe')
    await expect(preview.locator('#count')).toHaveText('42')
    await preview.locator('#count').click()
    await expect(preview.locator('#count')).toHaveText('43')
    await expect(preview.locator('#message')).toHaveText('first version')
    // Record document identity separately, so a reload restoring state cannot pass as HMR.
    await preview.locator('body').evaluate(()=>{(window as any).documentMarker='before-hmr'})
    await page.evaluate(projectRoot=>(window as any).viteSDK.kernel.writeText((projectRoot==='/'?'':projectRoot)+'/message.ts','export const message: string = "second version";'),projectRoot)
    await expect(preview.locator('#message')).toHaveText('second version')
    await expect(preview.locator('#count')).toHaveText('43')
    expect(await preview.locator('body').evaluate(()=>(window as any).documentMarker)).toBe('before-hmr')
    expect(await preview.locator('body').evaluate(()=>{try{void parent.document.body;return false}catch{return true}})).toBe(true)
    const frame=page.frames().find(frame=>frame.url()===previewOrigin+'/')!
    await frame.evaluate(()=>location.reload())
    await expect(preview.locator('#message')).toHaveText('second version')
    await expect(preview.locator('#count')).toHaveText('42')
    expect(await preview.locator('body').evaluate(()=>(window as any).documentMarker)).toBeUndefined()
    expect(diagnostics.filter(message=>/WebSocket|websocket|vite.*failed to connect/i.test(message))).toEqual([])
    const ownerOrigin=new URL(ownerURL).origin
    expect(requests.filter(url=>url.startsWith(ownerOrigin+'/')&&!url.startsWith(ownerURL))).toEqual([])
    await info.attach('sdk-vite-preview.png',{body:await page.screenshot(),contentType:'image/png'})
  }finally{
    await info.attach('sdk-vite-diagnostics.json',{body:JSON.stringify({projectRoot,diagnostics,requests,state:await page.evaluate(()=>{const state=(window as any).viteSDK;return {stage:state?.stage,install:state?.install,logs:state?.logs,previewRequests:state?.preview?.requests,previewDiagnostics:state?.preview?.diagnostics}})}),contentType:'application/json'})
    await page.evaluate(()=>{const state=(window as any).viteSDK;state?.preview?.close();state?.kernel?.close()})
  }
  await expect(page.locator('iframe')).toHaveCount(0)
})
