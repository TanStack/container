import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {observeSDKEngines} from '../sdk/engine-evidence'
import {exampleEnginePolicy} from '../../examples/sdk-frameworks/engine-policy.mjs'

const root=realpathSync(process.env.SDK_OUTPUT!)
const sdkManifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const engine=exampleEnginePolicy(sdkManifest)
const hosting=JSON.parse(readFileSync(resolve(root,'preview-host/hosting.json'),'utf8'))
const fixture=readFileSync('public/workloads/astro-build.json')
let owner:Server,previewHost:Server,ownerURL:string,previewOrigin:string
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
    if(path==='/app/fixture.json'){
      res.setHeader('Content-Type','application/json');res.end(fixture);return
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

test.afterAll(async()=>{
  for(const server of [owner,previewHost])if(server)await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))
})

test('built SDK runs Astro 7 static build and mounts its generated page through the preview contract',async({page,request},info)=>{
  const diagnostics:string[]=[],requests:string[]=[]
  page.on('pageerror',error=>diagnostics.push(error.message))
  page.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text())})
  page.on('request',request=>requests.push(request.url()))
  expect((await request.get(previewOrigin+'/')).status()).toBe(503)
  await page.goto(ownerURL)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const engineEvidence=observeSDKEngines(page,info,root,'experimentalFibers' in engine.options?'quickjs-als-asyncify-wasm-atomics-fibers-shared-storage':'quickjs-als-wasm')
  let completed=false
  try{
    const build=await page.evaluate(async({previewOrigin,engine})=>{
      const {WorkerKernel,URLPreview}=(window as any).sdk
      const encoded=(await fetch('./fixture.json').then(response=>response.json())).files as Record<string,{base64:string}>
      const decode=(base64:string)=>Uint8Array.from(atob(base64),character=>character.charCodeAt(0))
      const files=Object.fromEntries(Object.entries(encoded).map(([path,value])=>['/project'+path,decode(value.base64)]))
      files['/project/sdk-entry.mjs']=new TextEncoder().encode(`globalThis.__workloadRoot='/project';await import('./main.mjs')`)
      const state:any=(window as any).astroSDK={stage:'build'}
      const kernel=state.kernel=new WorkerKernel(files,{...engine.options,maxBytes:256*1024*1024,timeoutMs:60000,workspace:{maxBytes:128*1024*1024}})
      state.stage='workspace-ready-check'
      await kernel.readText('/project/sdk-entry.mjs')
      state.stage='execute'
      const result=state.result=await kernel.runModule('/project/sdk-entry.mjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:60000})
      if(result.exitCode!==0)throw Error('Astro build failed: '+result.stderr)
      const html=state.html=await kernel.readText('/project/dist/index.html')
      state.stage='preview'
      state.preview=await URLPreview.mount(document.querySelector('#preview'),{origin:previewOrigin,server:{fetch:async(request:Request)=>{
        const pathname=new URL(request.url).pathname
        const file=pathname==='/'?'/project/dist/index.html':'/project/dist'+pathname
        try{return new Response(await kernel.readFile(file),{status:200,headers:{'Content-Type':file.endsWith('.html')?'text/html':'application/octet-stream'}})}
        catch{return new Response('Not found',{status:404})}
      }}})
      state.stage='mounted'
      return {result,html}
    },{previewOrigin,engine})
    expect(build.result.stdout).toContain('__WORKLOAD_RESULT__3')
    expect(build.html).toContain('Fixture 3')
    await expect(page.frameLocator('#preview iframe').locator('h1')).toHaveText('Fixture 3',{timeout:30000})
    const ownerOrigin=new URL(ownerURL).origin
    expect(requests.filter(url=>url.startsWith(ownerOrigin+'/')&&!url.startsWith(ownerURL))).toEqual([])
    expect(diagnostics).toEqual([])
    await info.attach('sdk-astro-preview.png',{body:await page.screenshot(),contentType:'image/png'})
    completed=true
  }finally{
    try{
      const diagnosticPath=info.outputPath('sdk-astro-diagnostics.json')
      await writeFile(diagnosticPath,JSON.stringify({diagnostics,requests,state:await page.evaluate(()=>{
        const state=(window as any).astroSDK
        return {stage:state?.stage,result:state?.result,html:state?.html,previewRequests:state?.preview?.requests,previewDiagnostics:state?.preview?.diagnostics}
      }).catch(error=>({observationError:String(error)}))}))
      await info.attach('sdk-astro-diagnostics.json',{path:diagnosticPath,contentType:'application/json'})
      await page.evaluate(()=>{const state=(window as any).astroSDK;state?.preview?.close();state?.kernel?.close()}).catch(()=>{})
    }finally{if(completed)await engineEvidence.flush();else await engineEvidence.flush().catch(error=>info.attach('sdk-engine-observation-error.txt',{body:String(error),contentType:'text/plain'}))}
  }
  await expect(page.locator('iframe')).toHaveCount(0)
})
