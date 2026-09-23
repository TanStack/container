import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'

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
    if(new URL(req.url!,'http://localhost').searchParams.has('isolated')){
      res.setHeader('Cross-Origin-Opener-Policy','same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    }
    if(path==='/app/'){
      res.setHeader('Content-Type','text/html')
      res.end('<!doctype html><div id="preview"></div><script type="module">import {URLPreview} from "./vendor/index.js";window.URLPreview=URLPreview;</script>');return
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
    if(!route){res.writeHead(hosting.fallbackStatus,{'Content-Type':'text/plain',...hosting.fallbackHeaders});res.end('No browser workspace attached');return}
    res.writeHead(200,route.headers);res.end(readFileSync(resolve(root,'preview-host',route.file)))
  })
  ownerURL=await listen(owner)+'/app/';previewOrigin=await listen(previewHost)
})
test.afterAll(async()=>{for(const server of [owner,previewHost])if(server)await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

for(const [kind,expected] of [
  ['plain500','Preview document / returned HTTP 500'],
  ['html500','Preview document / returned HTTP 500'],
  ['redirect500','Preview document /next returned HTTP 500'],
  ['fragment','HTML without an explicit head element is not supported'],
  ['json','expected an HTML document, received application/json'],
] as const)test(`packaged preview reports ${kind} startup failure without waiting for inspection`,async({page},info)=>{
  await page.goto(ownerURL);await page.waitForFunction(()=>Boolean((window as any).URLPreview))
  const result=await page.evaluate(async({previewOrigin,kind})=>{
    const html='<!doctype html><html><head></head><body>Failure</body></html>'
    const started=performance.now(),seen:string[]=[]
    try{
      const preview=await (window as any).URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:{fetch:async(request:Request)=>{
        const path=new URL(request.url).pathname;seen.push(path)
        if(kind==='redirect500'&&path==='/')return new Response(null,{status:302,headers:{location:'/next'}})
        if(kind==='fragment')return new Response('<header>App</header>',{headers:{'content-type':'text/html'}})
        if(kind==='json')return Response.json({answer:42})
        return new Response(kind==='html500'?html:'server failed',{status:500,headers:{'content-type':kind==='html500'?'text/html':'text/plain'}})
      }}})
      preview.close();return {error:null,ms:performance.now()-started,seen}
    }catch(error){return {error:String(error),ms:performance.now()-started,seen}}
  },{previewOrigin,kind})
  await info.attach('preview-startup-result.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.error).toContain(expected)
  expect(result.ms).toBeLessThan(10000)
  if(kind==='redirect500')expect(result.seen).toEqual(['/','/next'])
  await expect(page.locator('iframe')).toHaveCount(0)
})

for(const isolated of [false,true])test(`packaged preview permits redirects and ordinary fetch404 while retaining the inspection handshake: isolated=${isolated}`,async({page},info)=>{
  await page.goto(ownerURL+(isolated?'?isolated':''));await page.waitForFunction(()=>Boolean((window as any).URLPreview))
  expect(await page.evaluate(()=>crossOriginIsolated)).toBe(isolated)
  const responses:{url:string;policy:string|undefined}[]=[]
  const diagnostics:string[]=[]
  page.on('console',message=>{if(diagnostics.length<32)diagnostics.push(message.type()+': '+message.text().slice(0,2000))})
  page.on('requestfailed',request=>{if(diagnostics.length<32)diagnostics.push(request.url()+': '+request.failure()?.errorText)})
  page.on('response',response=>{if(response.url().startsWith(previewOrigin))responses.push({url:response.url(),policy:response.headers()['cross-origin-embedder-policy']})})
  try{
    await page.evaluate(async(previewOrigin)=>{
      const html='<!doctype html><html><head></head><body><h1>Redirected app</h1><script>fetch("/missing").then(response=>document.body.dataset.apiStatus=String(response.status))</script></body></html>'
      const state:any=(window as any).previewStartup={seen:[]}
      state.preview=await (window as any).URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:{fetch:async(request:Request)=>{
        const path=new URL(request.url).pathname;state.seen.push(path)
        if(path==='/')return new Response(null,{status:307,headers:{location:'/next'}})
        if(path==='/missing')return new Response('missing',{status:404})
        return new Response(html,{headers:{'content-type':'text/html'}})
      }}})
    },previewOrigin)
    const frame=page.frameLocator('#preview iframe')
    await expect(frame.locator('h1')).toHaveText('Redirected app')
    await expect(frame.locator('body')).toHaveAttribute('data-api-status','404')
    expect(await frame.locator('body').evaluate(()=>{try{void parent.document.body;return false}catch{return true}})).toBe(true)
    const state=await page.evaluate(async()=>{const state=(window as any).previewStartup;return {seen:state.seen,inspection:await state.preview.inspect()}})
    expect(state.seen).toContain('/missing')
    for(const path of ['/next','/missing'])expect(responses.find(response=>response.url===previewOrigin+path)?.policy).toBe('require-corp')
    // Firefox does not emit a response event for the service-worker redirect.
    // The final document and fetch remain observable; unit coverage also checks 302 headers.
    const redirect=responses.find(response=>response.url===previewOrigin+'/')
    if(redirect)expect(redirect.policy).toBe('require-corp')
    expect(state.seen).toContain('/')
    expect(state.seen).toContain('/next')
    await info.attach('preview-startup-success.json',{body:JSON.stringify(state),contentType:'application/json'})
  }finally{
    writeFileSync(info.outputPath('preview-policy-responses.json'),JSON.stringify({responses,diagnostics},null,2))
    await info.attach('preview-policy-responses.json',{body:JSON.stringify({responses,diagnostics}),contentType:'application/json'})
    await page.evaluate(()=>(window as any).previewStartup?.preview?.close())
  }
})
