import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve,sep} from 'node:path'
import {createServer as createHTTPServer} from 'node:http'
import {createServer} from 'vite'
import {chromium,firefox,webkit} from '@playwright/test'
import {collectInstalledClosure} from './collect-installed-closure.mjs'

const runtime=resolve(process.env.NATIVE_VITE8_BUNDLE_DIR??'public/native-runtime')
const sdkOutput=process.env.NATIVE_SDK_OUTPUT?resolve(process.env.NATIVE_SDK_OUTPUT):undefined
const buildMode=process.env.NATIVE_SVELTEKIT_BUILD==='1'
const previewMode=process.env.NATIVE_SVELTEKIT_PREVIEW==='1'
const commandBuild=process.env.NATIVE_SVELTEKIT_BUILD_COMMAND==='1'
const commandDev=process.env.NATIVE_SVELTEKIT_DEV_COMMAND==='1'
const buildCommand=process.env.NATIVE_SVELTEKIT_COMMAND??'npm run build'
const browserName=process.env.NATIVE_TEST_BROWSER??'chromium'
const browserType={chromium,firefox,webkit}[browserName]
assert.ok(browserType,'NATIVE_TEST_BROWSER must be chromium, firefox, or webkit')
const fixtureRoot=resolve('fixtures/native-sveltekit')
const closure=await collectInstalledClosure(fixtureRoot,['@sveltejs/kit'])
for(const path of ['package.json','vite.config.js','src/app.html','src/routes/+page.svelte','src/routes/+page.server.js'])
  closure.files['/'+path]={base64:(await readFile(resolve(fixtureRoot,path))).toString('base64')}
const fixtureJSON=JSON.stringify({files:closure.files,links:closure.links,preparation:closure.preparation})
const assets=new Set(['engine.js','esbuild.wasm','lightningcss_node.wasm',
  'lightningcss-1.32.0.wasm','rolldown-binding.wasm32-wasi.wasm','wasi-worker-browser.mjs'])
const host=await createServer({server:{host:'127.0.0.1',port:0,headers:{
  'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
}},plugins:[{name:'native-sveltekit-probe-assets',configureServer(server){
  server.middlewares.use(async(req,res,next)=>{
    const path=new URL(req.url??'/','http://localhost').pathname
    if(sdkOutput&&(path==='/index.js'||path.startsWith('/runtime/'))){
      const file=resolve(sdkOutput,'.'+path)
      if(!file.startsWith(sdkOutput+sep))return next()
      try{
        res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':file.endsWith('.json')?'application/json':'text/javascript')
        res.setHeader('Cross-Origin-Opener-Policy','same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
        res.setHeader('Cross-Origin-Resource-Policy','same-origin')
        res.end(await readFile(file))
      }catch(error){res.statusCode=404;res.end(String(error))}
      return
    }
    if(path==='/probe'){
      res.setHeader('Cross-Origin-Opener-Policy','same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
      res.setHeader('Content-Type','text/html')
      res.end('<!doctype html><title>Native SvelteKit probe</title>')
      return
    }
    if(path==='/fixture.json'){
      res.setHeader('Cross-Origin-Resource-Policy','same-origin')
      res.setHeader('Content-Type','application/json')
      res.end(fixtureJSON)
      return
    }
    if(!path.startsWith('/vite-runtime/'))return next()
    const relative=path.slice('/vite-runtime/'.length)
    if(!assets.has(relative)&&!/^oxide\/[A-Za-z0-9._-]+\.(?:mjs|wasm)$/.test(relative))return next()
    const file=resolve(runtime,relative)
    if(!file.startsWith(runtime+sep))return next()
    try{
      res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'text/javascript')
      res.setHeader('Cross-Origin-Opener-Policy','same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
      res.setHeader('Cross-Origin-Resource-Policy','same-origin')
      res.end(await readFile(file))
    }catch(error){res.statusCode=404;res.end(String(error))}
  })
}}]})
await host.listen()
let previewHost
let previewOrigin
if(previewMode){
  const previewAssets=Object.fromEntries(await Promise.all(
    ['bridge.html','bridge.js','sw.js','inspect.js','websocket.js'].map(async name=>
      ['/__sandbox/'+name,await readFile(resolve('preview-host',name))])))
  const policy=JSON.parse(await readFile(resolve('src/sandbox/request-policy.json'),'utf8'))
  previewAssets['/__sandbox/request-policy.js']=Buffer.from(
    `self.SANDBOX_REQUEST_TIMEOUT_MS=${JSON.stringify(policy.maxRequestTimeoutMs)};`)
  previewHost=createHTTPServer((req,res)=>{
    const path=new URL(req.url??'/','http://localhost').pathname
    const asset=previewAssets[path]
    if(!asset||req.method!=='GET'){res.writeHead(503);res.end('No workspace attached');return}
    res.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    res.setHeader('Content-Type',path.endsWith('.html')?'text/html':'text/javascript')
    res.setHeader('Cache-Control','no-store')
    res.setHeader('Service-Worker-Allowed','/')
    res.end(asset)
  })
  await new Promise(resolve=>previewHost.listen(0,'127.0.0.1',resolve))
  previewOrigin=`http://127.0.0.1:${previewHost.address().port}`
}
const browser=await browserType.launch({headless:true})
try{
  const page=await browser.newPage()
  const errors=[]
  const notes=[]
  const failedRequests=[]
  page.on('requestfailed',request=>failedRequests.push({url:request.url(),failure:request.failure()}))
  page.on('response',response=>{if(response.status()>=400)failedRequests.push({url:response.url(),status:response.status()})})
  page.on('pageerror',error=>errors.push(error.message))
  page.on('console',message=>{
    if(message.text().startsWith('SVELTEKIT-PROBE-STAGE'))console.log(message.text())
    if(message.type()!=='error')return
    const value=message.text()
    if(value.startsWith('[BABEL] Note: The code generator has deoptimised the styling')||
      value.startsWith('Sourcemap for '))notes.push(value.trim())
    else errors.push(value)
  })
  await page.goto(host.resolvedUrls.local[0]+'probe')
  const result=await page.evaluate(async({buildMode,previewMode,previewOrigin,sdkModule,workerURL,commandBuild,commandDev,buildCommand})=>{
    const {NativeDevServer,URLPreview}=await import(sdkModule)
    let invalidStaticRootRejected=false
    try{new NativeDevServer({}, {workerURL,staticRoot:'relative'})}
    catch(error){invalidStaticRootRejected=String(error).includes('Path must be inside /app')}
    if(!invalidStaticRootRejected)throw Error('Invalid static root was not rejected before startup')
    const fixture=await(await fetch('/fixture.json')).json()
    const files=Object.fromEntries(Object.entries(fixture.files).map(([path,value])=>[
      '/app'+path,Uint8Array.from(atob(value.base64),character=>character.charCodeAt(0)),
    ]))
    files['/app/server.mjs']=`const zlib=await import('node:zlib');const input='browser Brotli round trip '.repeat(12);const encoded=zlib.brotliCompressSync(input);if(zlib.brotliDecompressSync(encoded).toString()!==input)throw Error('Brotli round trip failed');const vite=await import('vite');const server=await vite.createServer({server:{port:5178}});await server.listen();export default {fetch(){return new Response('ready')}}`
    const snapshot={version:3,files,directories:['/app/node_modules/.bin'],
      symlinks:Object.fromEntries(Object.entries(fixture.links).map(([path,target])=>['/app'+path,'/app'+target]))}
    const dev=new NativeDevServer({}, {workerURL,entry:'server.mjs',serveFetchEntry:true},snapshot)
    let workerFailure
    dev.worker.addEventListener('message',event=>{
      if(event.data?.ok===false)workerFailure={error:event.data.error,stack:event.data.stack}
    })
    let keep=false
    let stage='startup',output='',failureContext
    try{
      await dev.ready
      if(commandDev){
        const controller=new AbortController()
        const running=dev.terminalCommand('npm run dev','/app',text=>{output+=text},controller.signal)
        let runStatus
        void running.then(result=>{runStatus=result},error=>{runStatus={error:String(error)}})
        try{
          const deadline=performance.now()+30000
          let ports=[],candidate
          while(performance.now()<deadline){
            ports=await dev.ports()
            candidate=ports.find(port=>port!==5178&&port!==49152)
            if(candidate||/error|command not found/i.test(output))break
            await new Promise(resolve=>setTimeout(resolve,100))
          }
          let response
          if(candidate){stage='initial SSR fetch';response=await dev.fetch(new Request(`http://localhost:${candidate}/`,{signal:AbortSignal.timeout(10000)}))}
          const html=response?await response.text():''
          if(!previewMode)await dev.writeFile('/app/src/routes/+page.server.js','export function load(){return {answer:43}}')
          stage='updated SSR fetch'
          const updatedResponse=!previewMode&&candidate?await dev.fetch(new Request(`http://localhost:${candidate}/`,{signal:AbortSignal.timeout(10000)})):undefined
          const updated=updatedResponse?await updatedResponse.text():''
          stage='Vite client fetch'
          const clientResponse=candidate?await dev.previewServer(candidate).fetch(new Request(`http://localhost:${candidate}/@vite/client`,{signal:AbortSignal.timeout(10000)})):undefined
          let clientScript='',clientReadError,clientChunks=0
          if(clientResponse){
            const reader=clientResponse.body.getReader()
            const decoder=new TextDecoder()
            try{
              for(;;){
                const next=await reader.read()
                if(next.done)break
                clientChunks++
                clientScript+=decoder.decode(next.value,{stream:true})
              }
              clientScript+=decoder.decode()
            }catch(error){clientReadError=String(error)}
            finally{reader.releaseLock()}
          }
          if(!candidate||!response?.ok||!html.includes('SvelteKit 42')||!previewMode&&(!updatedResponse?.ok||
            !updated.includes('SvelteKit 43'))||!clientResponse?.ok||!clientScript||clientReadError)
            throw Error(`SvelteKit npm dev failed: ${JSON.stringify({ports,output:output.slice(-2000),status:response?.status,rendered:html.includes('SvelteKit 42'),updated:updated.includes('SvelteKit 43'),clientStatus:clientResponse?.status,clientHeaders:clientResponse?[...clientResponse.headers]:[],clientBytes:clientScript.length,clientChunks,clientReadError})}`)
          if(previewMode){
            const target=document.createElement('div')
            target.id='sveltekit-preview'
            document.body.append(target)
            window.__svelteWebSocketAttempts=[]
            window.__sveltePreview=await URLPreview.mount(target,{origin:previewOrigin,
              server:dev.previewServer(candidate),connectWebSocket:(url,protocols)=>{
                const attempt={url,protocols}
                window.__svelteWebSocketAttempts.push(attempt)
                return dev.previewWebSocket(candidate,previewOrigin,url,protocols).then(socket=>{
                  attempt.connected=true
                  return socket
                },error=>{attempt.error=String(error);throw error})
              }})
            window.__svelteDev=dev
            window.__svelteCommandController=controller
            window.__svelteCommandRun=running
            window.__svelteCommandPort=candidate
            keep=true
            return {commandDev:true,port:candidate,status:response.status,rendered:true,clientBytes:clientScript.length,
              output:output.slice(-1000),diagnostics:dev.diagnostics.slice(-5)}
          }
          controller.abort()
          const stopped=await running
          const portsAfter=await dev.ports()
          if(stopped.exitCode!==130||portsAfter.includes(candidate))
            throw Error(`SvelteKit npm dev failed: ${JSON.stringify({ports,portsAfter,output:output.slice(-2000),status:response?.status,rendered:html.includes('SvelteKit 42'),updated:updated.includes('SvelteKit 43'),exitCode:stopped.exitCode})}`)
          return {commandDev:true,port:candidate,status:response.status,rendered:true,updated:true,exitCode:stopped.exitCode,portClosed:true,
            output:output.slice(-1000),diagnostics:dev.diagnostics.slice(-5)}
        }catch(error){
          const portsBeforeAbort=await dev.ports().catch(()=>[])
          await new Promise(resolve=>setTimeout(resolve,500))
          failureContext={portsBeforeAbort,portsAfterDelay:await dev.ports().catch(()=>[]),runStatus,
            outputAfterDelay:output.slice(-2000)}
          throw error
        }
        finally{if(!keep){controller.abort();await running.catch(()=>{})}}
      }
      let commandFiles
      if(commandBuild){
        stage='terminal production build'
        const controller=new AbortController()
        const deadline=setTimeout(()=>controller.abort(Error('SvelteKit production command exceeded 90 seconds')),90000)
        let command
        try{
          command=await dev.terminalCommand(buildCommand,'/app',text=>{
            output+=text
            console.log('SVELTEKIT-PROBE-STAGE '+text.trim())
          },controller.signal)
        }finally{clearTimeout(deadline)}
        const client=command.changedPaths.some(path=>path.includes('/.svelte-kit/output/client/_app/immutable/entry/'))
        const server=command.changedPaths.some(path=>path.includes('/.svelte-kit/output/server/'))
        if(command.exitCode!==0||!client||!server){
          const analyse=await dev.readFile('/app/node_modules/@sveltejs/kit/src/core/postbuild/analyse.js')
            .then(value=>value.byteLength,()=>-1)
          throw Error(`SvelteKit terminal build failed: ${JSON.stringify({command:buildCommand,exitCode:command.exitCode,stderr:command.stderr.slice(-2000),stdout:output.slice(-4000),client,server,analyseBytes:analyse,changedPaths:command.changedPaths.slice(-20)})}`)
        }
        commandFiles=command.changedPaths
        if(!buildMode)return {commandBuild:true,exitCode:command.exitCode,client,server,
          changedPaths:command.changedPaths.length,stdout:output.slice(-1000),
          diagnostics:dev.diagnostics.slice(-5),progress:dev.progress.slice(-15)}
      }
      if(buildMode){
        console.log('SVELTEKIT-PROBE-STAGE build-start')
        const files=commandFiles??await dev.build()
        console.log('SVELTEKIT-PROBE-STAGE build-complete',files.length)
        const client=files.some(path=>path.includes('/.svelte-kit/output/client/_app/immutable/entry/'))
        const server=files.some(path=>path.includes('/.svelte-kit/output/server/'))
        if(!client||!server)throw Error(`Incomplete SvelteKit production output: client=${client}, server=${server}`)
        await dev.writeFile('/app/production.mjs',`import {create_server} from './.svelte-kit/output/server/index.js';import {manifest} from './.svelte-kit/output/server/manifest.js';const server=create_server(manifest);await server.init({env:{}});export default {fetch(request){return server.respond(request,{getClientAddress:()=> '127.0.0.1'})}}`)
        console.log('SVELTEKIT-PROBE-STAGE snapshot-start')
        const snapshot=await dev.snapshot()
        console.log('SVELTEKIT-PROBE-STAGE snapshot-complete',Object.keys(snapshot).length)
        await dev.dispose()
        console.log('SVELTEKIT-PROBE-STAGE build-worker-disposed')
        const production=new NativeDevServer(snapshot,{workerURL,
          entry:'production.mjs',serveFetchEntry:true,staticRoot:'/app/.svelte-kit/output/client',
          installDependencies:false,env:{NODE_ENV:'production'}})
        let productionReady=false
        let observed=0
        const monitor=setInterval(()=>{
          if(production.progress.length===observed)return
          observed=production.progress.length
          console.log('SVELTEKIT-PROBE-STAGE production-progress',JSON.stringify(production.progress.slice(-3)))
        },2000)
        let keepProduction=false
        try{
          console.log('SVELTEKIT-PROBE-STAGE production-start')
          const port=await Promise.race([production.ready,new Promise((_,reject)=>
            setTimeout(()=>reject(Error('Production startup did not finish in 45 seconds: '+JSON.stringify({
              progress:production.progress.slice(-12),diagnostics:production.diagnostics}))),45000))])
          productionReady=true
          console.log('SVELTEKIT-PROBE-STAGE production-ready',port)
          const response=await production.fetch(new Request(`http://localhost:${port}/`,{signal:AbortSignal.timeout(15000)}))
          const html=await response.text()
          if(!response.ok||!html.includes('SvelteKit 42'))throw Error(`Production response ${response.status}: ${html.slice(0,500)}`)
          const assetPath=files.find(path=>path.includes('/.svelte-kit/output/client/_app/immutable/entry/'))
            ?.slice('/app/.svelte-kit/output/client'.length)
          console.log('SVELTEKIT-PROBE-STAGE html-ready',response.status)
          const asset=await production.fetch(new Request(`http://localhost:${port}${assetPath}`,{signal:AbortSignal.timeout(15000)}))
          const assetBody=await asset.text()
          if(!asset.ok||!assetBody)throw Error(`Production asset response ${asset.status}: ${assetPath}`)
          if(previewMode){
            const target=document.createElement('div')
            target.id='sveltekit-preview'
            document.body.append(target)
            window.__sveltePreview=await URLPreview.mount(target,{origin:previewOrigin,
              server:production.previewServer(port)})
            window.__svelteDev=production
            keepProduction=true
          }
          return {build:true,files:files.slice(0,25),fileCount:files.length,
            client,server,production:{status:response.status,rendered:true,assetStatus:asset.status,
              assetType:asset.headers.get('content-type'),assetBytes:assetBody.length,
              diagnostics:production.diagnostics.slice(-5)},
            diagnostics:dev.diagnostics.slice(-5),progress:dev.progress.slice(-15)}
        }finally{
          clearInterval(monitor)
          if(!keepProduction){
            if(productionReady)await production.dispose()
            else production.close()
          }
        }
      }
      const ports=await dev.ports()
      const first=await dev.fetch(new Request('http://localhost:5178/'))
      const html=await first.text()
      if(!first.ok||!html.includes('SvelteKit 42'))throw Error(`Initial response ${first.status}: ${html.slice(0,500)}`)
      await dev.writeFile('/app/src/routes/+page.server.js','export function load(){return {answer:43}}')
      const second=await dev.fetch(new Request('http://localhost:5178/'))
      const updated=await second.text()
      if(!second.ok||!updated.includes('SvelteKit 43'))throw Error(`Changed response ${second.status}: ${updated.slice(0,500)}`)
      if(previewMode){
        const target=document.createElement('div')
        target.id='sveltekit-preview'
        document.body.append(target)
        window.__svelteWebSocketAttempts=[]
        const preview=await URLPreview.mount(target,{origin:previewOrigin,
          server:dev.previewServer(5178),connectWebSocket:(url,protocols)=>{
            const attempt={url,protocols}
            window.__svelteWebSocketAttempts.push(attempt)
            return dev.previewWebSocket(5178,previewOrigin,url,protocols).then(socket=>{
              attempt.connected=true
              return socket
            },error=>{attempt.error=String(error);throw error})
          }})
        window.__svelteDev=dev
        window.__sveltePreview=preview
        keep=true
      }
      return {ports,status:first.status,initial:html.includes('SvelteKit 42'),updated:updated.includes('SvelteKit 43'),
        diagnostics:dev.diagnostics.slice(-5),progress:dev.progress.slice(-15)}
    }catch(error){return {error:String(error),stack:error?.stack,stage,
      commandOutput:output.slice(-2000),failureContext,
      workerFailure,ports:await dev.ports().catch(()=>[]),
      diagnostics:dev.diagnostics.slice(-5),progress:dev.progress.slice(-15)}}
    finally{if(!keep)await dev.dispose()}
  },{buildMode,previewMode,previewOrigin,sdkModule:sdkOutput?'/index.js':'/src/sdk/index.ts',
    workerURL:sdkOutput?'/runtime/native/engine.js':'/vite-runtime/engine.js',commandBuild,commandDev,buildCommand})
  if(previewMode&&!result.error){
    const frame=page.frameLocator('#sveltekit-preview iframe')
    try{
      await frame.getByText(buildMode||commandDev?'SvelteKit 42':'SvelteKit 43').waitFor({timeout:30000})
      let hydrated=false
      const hydrationDeadline=Date.now()+20000
      while(!hydrated&&Date.now()<hydrationDeadline){
        hydrated=await frame.locator('#count').evaluate(element=>Object.getOwnPropertySymbols(element)
          .some(symbol=>symbol.description==='events'&&typeof element[symbol]?.click==='function')).catch(()=>false)
        if(!hydrated)await page.waitForTimeout(100)
      }
      if(!hydrated)throw Error('Svelte click handler was not attached after client module loads')
      await frame.locator('#count').click()
      await frame.getByText('Count: 1').waitFor({timeout:10000})
      if(buildMode){
        result.preview={rendered:true,interactive:true,production:true,
          requests:await page.evaluate(()=>window.__sveltePreview.requests.slice(-10))}
      }else{
        const edit=await page.evaluate(async()=>{
          const path='/app/src/routes/+page.svelte'
          const source=new TextDecoder().decode(await window.__svelteDev.readFile(path))
          if(!source.includes('Count: {count}'))throw Error('Svelte fixture text was not found')
          await window.__svelteDev.writeFile(path,source.replace('Count: {count}','Taps: {count}'))
          return true
        })
        await frame.getByText(/Taps: \d+/).waitFor({timeout:15000})
        result.preview={rendered:true,interactive:true,hotReloaded:edit,
          requests:await page.evaluate(()=>window.__sveltePreview.requests.slice(-10)),
          webSocketAttempts:await page.evaluate(()=>window.__svelteWebSocketAttempts)}
      }
    }catch(error){
      result.preview={error:String(error),html:(await frame.locator('body').innerHTML().catch(()=>'' )).slice(0,1000),
        hydrated:await frame.locator('#count').evaluate(element=>Object.getOwnPropertySymbols(element)
          .some(symbol=>symbol.description==='events'&&typeof element[symbol]?.click==='function')).catch(()=>false),
        requests:await page.evaluate(()=>window.__sveltePreview.requests.slice(-30)),
        webSocketAttempts:await page.evaluate(()=>window.__svelteWebSocketAttempts??[]),
        diagnostics:await page.evaluate(()=>window.__sveltePreview.diagnostics.slice(-10))}
      errors.push('SvelteKit preview interaction failed')
    }finally{
      const cleanup=await page.evaluate(async()=>{
        window.__sveltePreview.close()
        if(window.__svelteCommandController){
          window.__svelteCommandController.abort()
          const stopped=await window.__svelteCommandRun
          const portsAfter=await window.__svelteDev.ports()
          await window.__svelteDev.dispose()
          return {exitCode:stopped.exitCode,portClosed:!portsAfter.includes(window.__svelteCommandPort)}
        }
        await window.__svelteDev.dispose()
      })
      if(commandDev){
        result.commandCleanup=cleanup
        if(cleanup?.exitCode!==130||!cleanup.portClosed)errors.push('Terminal dev command did not stop cleanly')
      }
    }
  }
  const canceledRequests=failedRequests.filter(request=>
    request.failure&&/^(?:NS_BINDING_ABORTED|cancelled)$/.test(request.failure.errorText))
  const startupReloadCompleted=commandDev&&previewMode&&result.preview?.rendered&&
    result.preview.interactive&&result.preview.hotReloaded&&result.commandCleanup?.exitCode===130&&
    result.commandCleanup.portClosed&&result.output?.includes('forcing full-reload')&&canceledRequests.length>0
  const startupReloadErrors=startupReloadCompleted?errors.filter(error=>
    error.startsWith('error loading dynamically imported module: ')&&
      canceledRequests.some(request=>error.includes(request.url))||
    error==='TypeError: Importing a module script failed.') : []
  const fatalErrors=errors.filter(error=>!startupReloadErrors.includes(error))
  console.log(JSON.stringify({browser:browserName,version:browser.version(),runtime,sdkOutput,buildMode,commandBuild,commandDev,buildCommand,previewMode,isolation:await page.evaluate(()=>crossOriginIsolated),
    packages:closure.preparation.packages.length,files:Object.keys(closure.files).length,notes,
    startupReloadErrors,errors:fatalErrors,failedRequests,result},null,2))
  if(result.error||fatalErrors.length||result.diagnostics?.length)throw Error('SvelteKit browser probe failed; see the result above')
}finally{
  await browser.close()
  if(previewHost)await new Promise(resolve=>previewHost.close(resolve))
  await host.close()
}
