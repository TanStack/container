import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve,sep} from 'node:path'
import {createServer as createHTTPServer} from 'node:http'
import {createServer} from 'vite'
import {chromium,firefox,webkit} from '@playwright/test'
import {collectInstalledClosure} from './collect-installed-closure.mjs'

const runtime=resolve(process.env.NATIVE_VITE8_BUNDLE_DIR??'public/native-runtime')
const sdkOutput=process.env.NATIVE_SDK_OUTPUT?resolve(process.env.NATIVE_SDK_OUTPUT):undefined
const browserName=process.env.NATIVE_TEST_BROWSER??'chromium'
const commandDev=process.env.NATIVE_ASTRO_DEV_COMMAND==='1'
const previewMode=process.env.NATIVE_ASTRO_PREVIEW==='1'
if(previewMode&&!commandDev)throw Error('Preview mode requires NATIVE_ASTRO_DEV_COMMAND=1')
const commandMode=process.env.NATIVE_ASTRO_BUILD_COMMAND==='1'||commandDev
const diagnosticVersion=process.env.NATIVE_ASTRO_DIAGNOSTIC_VERSION==='1'
const traceActivity=process.env.NATIVE_ASTRO_TRACE_ACTIVITY==='1'
const browserType={chromium,firefox,webkit}[browserName]
assert.ok(browserType,'NATIVE_TEST_BROWSER must be chromium, firefox, or webkit')
const fixtureRoot=resolve('fixtures/native-astro')
const closure=await collectInstalledClosure(fixtureRoot,['astro'])
if(process.env.NATIVE_ASTRO_TRACE_RENDER==='1'){
  const plugin=closure.files['/node_modules/astro/dist/vite-plugin-astro/index.js']
  if(!plugin)throw Error('Astro compiler plugin is missing')
  const pluginSource=Buffer.from(plugin.base64,'base64').toString('utf8')
  const compileMarker='const transformResult = await compile(source, filename, parsedId.query.container);'
  if(!pluginSource.includes(compileMarker))throw Error('Astro compiler instrumentation point changed')
  plugin.base64=Buffer.from(pluginSource.replace(compileMarker,'console.log("RENDER_SOURCE",filename,JSON.stringify(source));'+compileMarker)).toString('base64')
  const stream=closure.files['/node_modules/astro/dist/runtime/server/render/streaming.js']
  if(!stream)throw Error('Astro streaming module is missing')
  const streamSource=Buffer.from(stream.base64,'base64').toString('utf8')
  const streamMarker='const stack = [root];'
  if(!streamSource.includes(streamMarker))throw Error('Astro streaming instrumentation point changed')
  stream.base64=Buffer.from(streamSource.replace(streamMarker,'console.log("RENDER_ROOT",JSON.stringify(root?.htmlParts),JSON.stringify(root?.expressions));'+streamMarker)).toString('base64')
  const path='/node_modules/astro/dist/vite-plugin-astro-server/response.js'
  const file=closure.files[path]
  if(!file)throw Error('Astro response module is missing')
  const source=Buffer.from(file.base64,'base64').toString('utf8')
  const marker='const { status, headers, body, statusText } = webResponse;'
  if(!source.includes(marker))throw Error('Astro response instrumentation point changed')
  file.base64=Buffer.from(source.replace(marker,marker+'console.log("RENDER_RESPONSE",status,Boolean(body),Symbol.for("astro.responseBody") in webResponse);')
    .replace('res.write(chunk.toString());','console.log("RENDER_CHUNK",chunk.toString().length);res.write(chunk.toString());')
    .replace('if (value) {','if (value) {console.log("RENDER_WEB_CHUNK",value.byteLength);')).toString('base64')
}
if(diagnosticVersion){
  const cli=closure.files['/node_modules/astro/bin/astro.mjs']
  if(!cli)throw Error('Astro CLI is missing from the installed fixture')
  const source=Buffer.from(cli.base64,'base64').toString('utf8')
  const guard="const engines = '>=22.12.0';"
  if(!source.includes(guard))throw Error('Astro CLI version guard changed')
  cli.base64=Buffer.from(source.replace(guard,"const engines = '>=22.0.0';")).toString('base64')
}
for(const path of ['package.json','src/pages/index.astro'])closure.files['/'+path]={
  base64:(await readFile(resolve(fixtureRoot,path))).toString('base64'),
}
const fixtureJSON=JSON.stringify({files:closure.files,links:closure.links,preparation:closure.preparation})
const assets=new Set(['engine.js','esbuild.wasm','lightningcss_node.wasm',
  'lightningcss-1.32.0.wasm','rolldown-binding.wasm32-wasi.wasm','wasi-worker-browser.mjs'])
const server=await createServer({server:{host:'127.0.0.1',port:0,headers:{
  'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
}},plugins:[{name:'native-astro-probe-assets',configureServer(server){
  server.middlewares.use(async(req,res,next)=>{
    const path=new URL(req.url??'/', 'http://localhost').pathname
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
      res.end('<!doctype html><title>Native Astro compatibility probe</title>')
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
await server.listen()
let previewHost,previewOrigin
if(previewMode){
  const assets=Object.fromEntries(await Promise.all(['bridge.html','bridge.js','sw.js','inspect.js','websocket.js'].map(async name=>['/__sandbox/'+name,await readFile(resolve('preview-host',name))])))
  const policy=JSON.parse(await readFile('src/sandbox/request-policy.json','utf8'))
  assets['/__sandbox/request-policy.js']=Buffer.from(`self.SANDBOX_REQUEST_TIMEOUT_MS=${JSON.stringify(policy.maxRequestTimeoutMs)};`)
  previewHost=createHTTPServer((request,response)=>{
    const path=new URL(request.url??'/','http://localhost').pathname
    if(!assets[path]||request.method!=='GET'){response.writeHead(503);response.end('No workspace attached');return}
    response.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    response.setHeader('Content-Type',path.endsWith('.html')?'text/html':'text/javascript')
    response.setHeader('Cache-Control','no-store')
    response.setHeader('Service-Worker-Allowed','/')
    response.end(assets[path])
  })
  await new Promise(resolve=>previewHost.listen(0,'127.0.0.1',resolve))
  previewOrigin=`http://127.0.0.1:${previewHost.address().port}`
}
const browser=await browserType.launch({headless:true})
try{
  const page=await browser.newPage()
  const errors=[],requests=[],errorDetails=[]
  let phase='startup'
  page.on('pageerror',error=>{errors.push(error.message);errorDetails.push({phase,error:error.message})})
  page.on('console',message=>{if(message.type()==='error'){errors.push(message.text());errorDetails.push({phase,error:message.text()})}})
  page.on('request',request=>{if(request.url().includes('/vite-runtime/'))requests.push({url:request.url(),method:request.method()})})
  page.on('requestfailed',request=>requests.push({url:request.url(),failure:request.failure()}))
  page.on('response',response=>{if(response.status()>=400)requests.push({url:response.url(),status:response.status()})})
  await page.goto(server.resolvedUrls.local[0]+'probe')
  const isolation=await page.evaluate(()=>crossOriginIsolated)
  const result=await page.evaluate(async({baseline,devMode,commandMode,commandDev,previewMode,previewOrigin,traceActivity,sdkModule,workerURL})=>{
    const {NativeDevServer,URLPreview}=await import(sdkModule)
    const fixture=baseline?{files:{}}:await(await fetch('/fixture.json')).json()
    const files=Object.fromEntries(Object.entries(fixture.files).map(([path,value])=>[
      '/app'+path,Uint8Array.from(atob(value.base64),character=>character.charCodeAt(0)),
    ]))
    // Snapshot mounting transfers these buffers to the worker.
    const originalPage=new TextDecoder().decode(files['/app/src/pages/index.astro'])
    if(baseline){
      files['/app/binding/package.json']='{"main":"index.cjs","browser":"browser.js"}'
      files['/app/binding/index.cjs']='module.exports=42'
      files['/app/binding/browser.js']='export default 0'
    }
    files['/app/server.mjs']=(commandMode?'':baseline?
      'const {createRequire}=await import("node:module");if(createRequire(import.meta.url)("./binding")!==42)throw Error("createRequire failed");if(process.platform!=="linux"||process.arch!=="x64")throw Error("process platform mismatch");':
      `try {
        const fs=await import('node:fs')
        if(!fs.existsSync('/app/src/pages/index.astro'))throw Error('Astro page is missing from mounted volume')
        const astro=await import('astro')
        if(process.env.NATIVE_ASTRO_DEV==='1'){
          await astro.dev({root:new URL('file:///app/'),configFile:false,logLevel:'error'})
        }else await astro.build({root:new URL('file:///app/'),configFile:false,logLevel:'error'})
      } catch (error) {
        const fs=await import('node:fs')
        const chunkPath='/app/dist/.prerender/chunks'
        const chunks=fs.existsSync(chunkPath)?fs.readdirSync(chunkPath):'missing directory'
        const causes=[]
        for(let current=error;current&&causes.length<12;current=current.cause)
          causes.push(String(current.stack??current))
        throw Error('Prerender chunks: '+JSON.stringify(chunks)+'\\n'+causes.join('\\nCAUSE: ').slice(0,6000))
      }`)+
      'export default {fetch(){return new Response("ready")}}'
    const options={workerURL,entry:'server.mjs',serveFetchEntry:true,
      env:{ASTRO_TELEMETRY_DISABLED:'1',NAPI_RS_FORCE_WASI:'error',NATIVE_ASTRO_DEV:devMode?'1':'',
        ...(traceActivity?{NATIVE_COMMAND_ACTIVITY_TRACE:'1'}:{})}}
    const dev=commandMode?new NativeDevServer({},options,{
      version:3,files,directories:['/app/node_modules/.bin'],
      symlinks:Object.fromEntries(Object.entries(fixture.links).map(([path,target])=>['/app'+path,'/app'+target])),
    }):new NativeDevServer(files,options)
    let workerFailure,terminal,keep=false
    dev.worker.addEventListener('message',event=>{
      if(event.data?.ok===false)workerFailure={error:event.data.error,stack:event.data.stack}
    })
    try{
      await dev.ready
      let html=''
      let ports=[]
      if(commandMode){
        const inheritedEnv=await dev.terminalCommand('printf "%s" "$ASTRO_TELEMETRY_DISABLED"','/app')
        if(inheritedEnv.exitCode!==0||inheritedEnv.stdout!=='1')
          throw Error(`Terminal did not inherit project environment: ${JSON.stringify(inheritedEnv)}`)
        const session=await dev.openTerminalSession('/app')
        try{
          const sessionEnv=await session.runCommand('printf "%s" "$ASTRO_TELEMETRY_DISABLED"')
          if(sessionEnv.exitCode!==0||sessionEnv.stdout!=='1')
            throw Error(`Terminal session did not inherit project environment: ${JSON.stringify(sessionEnv)}`)
        }finally{await session.dispose()}
        if(commandDev){
          const controller=new AbortController()
          let output='',status
          const running=dev.terminalCommand('npm run dev','/app',text=>{output+=text},controller.signal)
          void running.then(result=>{status=result},error=>{status={error:String(error)}})
          try{
            const deadline=performance.now()+30000
            while(performance.now()<deadline){
              ports=await dev.ports()
              if(ports.includes(4321)&&output.includes('watching for file changes'))break
              if(status)throw Error(`Astro dev exited before listening: ${JSON.stringify(status)} ${output}`)
              await new Promise(resolve=>setTimeout(resolve,100))
            }
            if(!ports.includes(4321))throw Error(`Astro dev did not listen: ${output}`)
            const waitForPage=async(marker)=>{
              const deadline=performance.now()+10000
              let last='no response'
              while(performance.now()<deadline){
                if(status)throw Error(`Astro dev exited: ${JSON.stringify(status)} ${output}`)
                try{
                  const response=await dev.fetch(new Request('http://localhost:4321/',{signal:AbortSignal.timeout(2000)}))
                  const body=await response.text()
                  if(response.ok&&body.includes(marker))return body
                  last=`${response.status} ${body.slice(-500)}`
                }catch(error){last=String(error)}
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              throw Error(`Astro CLI did not serve ${marker}: ${last} ${output}`)
            }
            html=await waitForPage('Astro 42')
            await waitForPage('Astro 42')
            if(previewMode){
              const target=document.createElement('div');target.id='astro-preview';document.body.append(target)
              window.__astroPreview=await URLPreview.mount(target,{origin:previewOrigin,server:dev.previewServer(4321),
                connectWebSocket:(url,protocols)=>dev.previewWebSocket(4321,previewOrigin,url,protocols)})
              Object.assign(window,{__astroDev:dev,__astroController:controller,__astroRunning:running})
              keep=true
              return {htmlIncludesExpected:true,previewMounted:true}
            }
            await dev.writeFile('/app/src/pages/index.astro',originalPage.replace('42','43'))
            await waitForPage('Astro 43')
          }finally{if(!keep){controller.abort();terminal=await running}}
          const remaining=await dev.ports()
          if(remaining.includes(4321))throw Error('Stopping Astro CLI did not release port 4321')
        }else{
        terminal=await dev.terminalCommand('npm run build','/app')
        if(terminal.exitCode!==0)throw Error(`Astro terminal build exited ${terminal.exitCode}: ${(terminal.stdout+terminal.stderr).slice(-3000)}`)
        html=new TextDecoder().decode(await dev.readFile('/app/dist/index.html'))
        }
      }else if(devMode){
        ports=await dev.ports()
        const response=await dev.fetch(new Request('http://localhost:4321/'))
        html=await response.text()
        if(!response.ok)throw Error(`Astro dev response ${response.status}: ${html.slice(0,500)}`)
        if(!html.includes('Astro 42'))throw Error('Astro dev response omitted initial page content')
        await dev.writeFile('/app/src/pages/index.astro',originalPage.replace('42','43'))
        const updated=await dev.fetch(new Request('http://localhost:4321/'))
        const updatedHtml=await updated.text()
        if(!updated.ok||!updatedHtml.includes('Astro 43'))
          throw Error(`Astro dev did not reload changed source: ${updated.status} ${updatedHtml.slice(-500)}`)
      }else try{html=new TextDecoder().decode(await dev.readFile('/app/dist/index.html'))}
      catch{}
      return {html:html.slice(0,500),htmlIncludesExpected:html.includes('Astro 42'),ports,
        terminal:terminal&&{exitCode:terminal.exitCode,stdout:terminal.stdout.slice(-3000),stderr:terminal.stderr.slice(traceActivity?-50000:-3000)},
        progress:dev.progress.slice(-20),diagnostics:dev.diagnostics.slice(-5)}
    }catch(error){return {error:String(error),stack:error?.stack,workerFailure,
      terminal:terminal&&{exitCode:terminal.exitCode,stdout:terminal.stdout.slice(-3000),stderr:terminal.stderr.slice(traceActivity?-50000:-3000)},progress:dev.progress.slice(-20),
      diagnostics:dev.diagnostics.slice(-5)}}
    finally{if(!keep)await dev.dispose()}
  },{baseline:process.env.NATIVE_ASTRO_BASELINE==='1',devMode:process.env.NATIVE_ASTRO_DEV==='1',commandMode,commandDev,previewMode,previewOrigin,traceActivity,
    sdkModule:sdkOutput?'/index.js':'/src/sdk/index.ts',workerURL:sdkOutput?'/runtime/native/engine.js':'/vite-runtime/engine.js'})
  if(previewMode&&!result.error){
    try{
      phase='preview-initial'
      const frame=page.frameLocator('#astro-preview iframe')
      await frame.getByRole('heading',{name:'Astro 42'}).waitFor({timeout:30000})
      await frame.locator('astro-dev-toolbar').waitFor({state:'attached',timeout:30000})
      phase='preview-edit'
      await page.evaluate(async(atomic)=>{
        const path='/app/src/pages/index.astro'
        const source=new TextDecoder().decode(await window.__astroDev.readFile(path))
        if(!source.includes('42'))throw Error('Initial Astro source missing')
        const next=source.replace('42','43')
        if(atomic){
          await window.__astroDev.writeFile(path+'.tmp',next)
          const moved=await window.__astroDev.terminalCommand('mv src/pages/index.astro.tmp src/pages/index.astro')
          if(moved.exitCode!==0)throw Error('Atomic save failed: '+moved.stderr)
        }else await window.__astroDev.writeFile(path,next)
      },process.env.NATIVE_ASTRO_ATOMIC_EDIT==='1')
      await frame.getByRole('heading',{name:'Astro 43'}).waitFor({timeout:20000})
      await frame.locator('astro-dev-toolbar').waitFor({state:'attached',timeout:30000})
      phase='preview-updated'
      result.preview={rendered:true,updated:true,atomicEdit:process.env.NATIVE_ASTRO_ATOMIC_EDIT==='1'}
    }catch(error){
      result.error=String(error)
      result.previewDiagnostics=await page.evaluate(()=>({
        diagnostics:window.__astroPreview?.diagnostics?.slice(-20),
        requests:window.__astroPreview?.requests?.slice(-20),
      }))
    }
    finally{phase='cleanup';await page.evaluate(async()=>{window.__astroController.abort();await window.__astroRunning;window.__astroPreview.close();await window.__astroDev.dispose()})}
  }
  console.log(JSON.stringify({browser:browserName,browserVersion:browser.version(),
    astroVersion:'7.3.5',files:Object.keys(closure.files).length,runtime,sdkOutput,isolation,
    errors:errors.slice(0,30),errorCount:errors.length,errorDetails:errorDetails.slice(0,30),
    requests:requests.slice(-40),requestIssueCount:requests.length,result},null,2))
  if(result.error||errors.length||result.diagnostics?.length)throw Error('Astro browser probe failed; see the result above')
  if(process.env.NATIVE_ASTRO_BASELINE!=='1')assert.equal(result.htmlIncludesExpected,true)
}finally{
  await browser.close()
  if(previewHost)await new Promise(resolve=>previewHost.close(resolve))
  await server.close()
}
