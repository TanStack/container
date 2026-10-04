import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {execFileSync} from 'node:child_process'
import {stripVTControlCharacters} from 'node:util'
import {build as buildHost} from 'esbuild'
import {createServer as createHTTPServer} from 'node:http'
import {createServer} from 'vite'
import {chromium,firefox,webkit,expect} from '@playwright/test'
import {verifyStreamingDelivery} from '../scripts/streaming-delivery-contract.mjs'
import {runWithCleanup} from '../scripts/run-with-cleanup.mjs'
import {nativeBinaryShellFiles} from './fixtures/native-binary-shell.mjs'
import {stdinLifecycleSources} from './fixtures/native-stdin-lifecycle.mjs'
import {nativeSpawnFiles} from './fixtures/native-spawn.mjs'
import {nativeWorkerEvalParent,nativeWorkerEvalExpected} from './fixtures/native-worker-eval.mjs'
import {nativeWorkerPreloadFiles,nativeWorkerPreloadExpected,nativeWorkerNestedPreloadExpected} from './fixtures/native-worker-preloads.mjs'
import {nativeWorkerDataParent,nativeWorkerDataExpected} from './fixtures/native-worker-data-url.mjs'
import {nativeAppForkFiles,nativeAppForkExpected} from './fixtures/native-app-fork.mjs'
import {nativeInheritedInputFiles,nativeInheritedInputExpected,nativeInheritedLargeInputExpected,nativeInheritedCompetingExpected,nativeInheritedCancelledExpected,nativeForkDefaultExpected} from './fixtures/native-child-inherited-input.mjs'
import {nativeExecFileFiles,nativeExecFileExpected} from './fixtures/native-exec-file.mjs'
import {nativeChildAbortFiles,nativeChildAbortExpected} from './fixtures/native-child-abort.mjs'
import {nativeNodeEvalFiles,nativeNodeEvalExpected,nativeNodeEsmExpected,nativeNodeEsmFailuresExpected} from './fixtures/native-node-eval.mjs'
import {nativeChildStdioFiles,nativeChildStdioExpected} from './fixtures/native-child-stdio.mjs'
import {safariInstallStageTraceSource} from '../scripts/safari-install-stage-trace.mjs'
import {probeVMFunctionIdentity,vmFunctionIdentitySource,probeVMPersistentState,vmPersistentStateSource,probeVMFunctionSource,vmFunctionSourceSource} from './fixtures/native-vm-function-identity.mjs'
import {Script as NativeScript,runInNewContext} from 'node:vm'
import nativeNet from 'node:net'
import {probeSocketShutdown,socketShutdownSource} from './fixtures/native-socket-shutdown.mjs'
import {probeStreamResponse} from './fixtures/native-stream-response.mjs'

async function verifyVisibleStream(frame,name,index){
  return verifyStreamingDelivery({label:name,
    click:()=>frame.getByRole('button',{name}).click(),
    read:()=>frame.locator('#streamed-results pre').nth(index).textContent(),
    poll:(read,message)=>expect.poll(read,{message,timeout:20000,intervals:[50,100,200]}).toBe(true),
  })
}

async function reportProductionPreviewFailure(page,error,phase='interaction'){
  const evidence=await page.evaluate(()=>({
    requests:window.nativeProductionPreview?.requests?.slice(-30),
    previewDiagnostics:window.nativeProductionPreview?.diagnostics?.slice(-20),
    runtimeDiagnostics:window.nativeProductionDev?.diagnostics?.slice(-20),
    runtimeProgress:window.nativeProductionDev?.progress?.slice(-20),
  })).catch(failure=>({unavailable:String(failure)}))
  console.error('PRODUCTION_PREVIEW_FAILURE',JSON.stringify({phase,error:String(error),evidence}))
}

test('persistent native Vite worker serves edits and HMR through owner transport',async()=>{
  const output=process.env.NATIVE_VITE8_BUNDLE_DIR??await mkdtemp(join(tmpdir(),'native-dev-server-'))
  if(!process.env.NATIVE_VITE8_BUNDLE_DIR)execFileSync(process.execPath,['scripts/build-browser-vite.mjs'],{
    env:{...process.env,BROWSER_VITE_OUTPUT_DIRECTORY:output,BROWSER_VITE_ENTRY_POINT:resolve('src/native/dev-server.worker.ts')},
    stdio:'pipe',
  })
  const server=await createServer({server:{host:'127.0.0.1',port:0,headers:process.env.NATIVE_VITE8_BUNDLE_DIR?{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}:undefined},plugins:[{
    name:'native-dev-worker-assets',configureServer(server){server.middlewares.use(async(req,res,next)=>{
      if(req.url==='/native-dev-preview'){
        if(process.env.NATIVE_VITE8_BUNDLE_DIR){
          res.setHeader('Cross-Origin-Opener-Policy','same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
        }
        res.setHeader('Content-Type','text/html')
        res.end('<!doctype html><div id="preview"></div>')
        return
      }
      const pathname=new URL(req.url??'/', 'http://localhost').pathname
      if(process.env.NATIVE_VITEST_FIXTURE_DIR&&['/fixtures/install-vitest/package.json','/fixtures/install-vitest/package-lock.json'].includes(pathname)){
        res.setHeader('Content-Type','application/json')
        res.end(await readFile(join(process.env.NATIVE_VITEST_FIXTURE_DIR,pathname.split('/').pop())))
        return
      }
      const sdkRuntimePrefix=pathname.startsWith('/native-sdk/runtime/')?'/native-sdk/runtime/':
        pathname.startsWith('/runtime/')&&!process.env.NATIVE_DEPLOYMENT_DIR?'/runtime/':undefined
      if(sdkRuntimePrefix&&process.env.NATIVE_SDK_BUNDLE_DIR){
        const root=resolve(process.env.NATIVE_SDK_BUNDLE_DIR,'runtime')
        const file=resolve(root,pathname.slice(sdkRuntimePrefix.length))
        if(!file.startsWith(root+sep))return next()
        try{
          res.setHeader('Cross-Origin-Opener-Policy','same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
          res.setHeader('Cross-Origin-Resource-Policy','same-origin')
          res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'text/javascript')
          res.end(await readFile(file))
        }catch(error){res.statusCode=404;res.end(String(error))}
        return
      }
      if(pathname.startsWith('/runtime/')&&process.env.NATIVE_DEPLOYMENT_DIR){
        const root=resolve(process.env.NATIVE_DEPLOYMENT_DIR,'runtime')
        const file=resolve(root,pathname.slice('/runtime/'.length))
        if(!file.startsWith(root+sep))return next()
        try{
          res.setHeader('Cross-Origin-Opener-Policy','same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
          res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'text/javascript')
          res.end(await readFile(file))
        }catch(error){res.statusCode=404;res.end(String(error))}
        return
      }
      if(pathname==='/native-sdk/index.js'){
        res.setHeader('Content-Type','text/javascript')
        res.end(process.env.NATIVE_SDK_BUNDLE_DIR
          ?await readFile(join(process.env.NATIVE_SDK_BUNDLE_DIR,'index.js'))
          :'export * from "/src/sdk/index.ts";')
        return
      }
      const prefix=['/vite-runtime/','/portable/runtime/'].find(value=>pathname.startsWith(value))
      const relative=prefix?pathname.slice(prefix.length):''
      const asset=relative==='selected-engine.js'&&process.env.NATIVE_RENAMED_ENGINE==='1'?'engine.js':['engine.js','classic-worker-bootstrap.js','esbuild.wasm','lightningcss_node.wasm','lightningcss-1.32.0.wasm','rolldown-binding.wasm32-wasi.wasm','wasi-worker-browser.mjs','oxide/tailwindcss-oxide.wasm32-wasi.wasm'].includes(relative)||/^oxide\/(oxide|wasi-worker-browser|chunk-[A-Z0-9]+)\.mjs$/.test(relative)?relative:undefined
      if(!asset)return next()
      try{
        if(process.env.NATIVE_VITE8_BUNDLE_DIR){
          res.setHeader('Cross-Origin-Opener-Policy','same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
          res.setHeader('Cross-Origin-Resource-Policy','same-origin')
        }
        res.setHeader('Content-Type',asset.endsWith('.wasm')?'application/wasm':'text/javascript')
        const bytes=await readFile(join(output,asset))
        res.end(asset==='engine.js'&&process.env.NATIVE_INSTALL_STAGE_TRACE==='1'?safariInstallStageTraceSource+bytes.toString('utf8'):bytes)
      }
      catch(error){res.statusCode=500;res.end(String(error))}
    })},
  }]})
  const previewAssets=Object.fromEntries(await Promise.all(['bridge.html','bridge.js','sw.js','inspect.js','websocket.js','request-policy.js'].map(async name=>[
    '/__sandbox/'+name,
    await readFile(process.env.NATIVE_DEPLOYMENT_DIR
      ?join(process.env.NATIVE_DEPLOYMENT_DIR,'preview-host/__sandbox',name)
      :name==='request-policy.js'?resolve('src/sandbox/request-policy.json'):resolve('preview-host',name)),
  ])))
  if(!process.env.NATIVE_DEPLOYMENT_DIR){
    const policy=JSON.parse(previewAssets['/__sandbox/request-policy.js'].toString('utf8'))
    previewAssets['/__sandbox/request-policy.js']=Buffer.from(`self.SANDBOX_REQUEST_TIMEOUT_MS=${JSON.stringify(policy.maxRequestTimeoutMs)};`)
  }
  const previewHost=createHTTPServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    const asset=previewAssets[path]
    if(!asset||req.method!=='GET'){res.writeHead(503);res.end('No workspace attached');return}
    if(process.env.NATIVE_VITE8_BUNDLE_DIR){
      res.setHeader('Cross-Origin-Resource-Policy','cross-origin')
      res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    }
    res.setHeader('Content-Type',path.endsWith('.html')?'text/html':'text/javascript')
    res.setHeader('Cache-Control','no-store')
    res.setHeader('Service-Worker-Allowed','/')
    if(path.endsWith('.html'))res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'")
    res.end(asset)
  })
  await server.listen()
  await new Promise(resolve=>previewHost.listen(0,'127.0.0.1',resolve))
  const previewOrigin=`http://127.0.0.1:${previewHost.address().port}`
  const sourceRoot=process.env.TANSTACK_ROUTER_SOURCE??'/Users/tannerlinsley/GitHub/router'
  const realExample=process.env.NATIVE_REAL_ROUTER_SSR==='1'||process.env.NATIVE_REAL_ROUTER_ENTRY==='1'?'react-router-ssr':process.env.NATIVE_REAL_START_BASIC==='1'?'react-basic':process.env.NATIVE_REAL_START_STREAMING==='1'?'react-streaming':process.env.NATIVE_REAL_SOLID_COUNTER==='1'?'solid-counter':process.env.NATIVE_REAL_COUNTER==='1'?'react-counter':undefined
  const realKind=realExample?.startsWith('solid')?'solid':realExample?'react':undefined
  const examplePath=realKind?`examples/${realKind}/${realExample==='react-router-ssr'?'basic-ssr-file-based':realExample==='react-basic'?'start-basic':realExample==='react-streaming'?'start-streaming-data-from-server-functions':'start-counter'}`:undefined
  const realCounter=examplePath
    ?Object.fromEntries(await Promise.all(execFileSync('git',['-C',sourceRoot,'ls-files',examplePath],{encoding:'utf8'}).trim().split('\n').map(async path=>[
      '/app/'+path.slice(examplePath.length+1),
      new Uint8Array(await readFile(join(sourceRoot,path))),
    ])))
    :undefined
  const realFixture=realExample==='react-router-ssr'?'fixtures/native-real-router-ssr':realExample==='react-basic'?'fixtures/native-real-start-basic':realExample==='react-streaming'?'fixtures/native-real-start-streaming':realKind==='solid'?'fixtures/native-real-solid-counter':'fixtures/native-real-counter'
  const exactLock=realCounter&&process.env.NATIVE_AUTO_PROJECT_LOCK!=='1'?await (async()=>{
    const bundle=await buildHost({entryPoints:['src/npm/project.ts'],bundle:true,platform:'node',format:'esm',write:false})
    const {planProjectInstall}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
    const manifest=await readFile(resolve(realFixture,'package.json'),'utf8')
    const lock=await readFile(resolve(realFixture,'package-lock.json'),'utf8')
    const plan=planProjectInstall(manifest,lock)
    assert.ok(plan.result.skippedPlatformPackages.length>0)
    return plan.lock
  })():undefined
  try{
    for(const browserType of (process.env.NATIVE_VITE8_BUNDLE_DIR?[chromium,firefox,webkit]:[chromium,firefox]).filter(browser=>!process.env.NATIVE_TEST_BROWSER||browser.name()===process.env.NATIVE_TEST_BROWSER)){
      const browser=await browserType.launch({headless:true})
      try{
        const page=await browser.newPage()
        const pageErrors=[]
        let ignoredChildOutputLeaked=false
        page.on('crash',()=>console.error('NATIVE_PAGE_LIFETIME',JSON.stringify({browser:browserType.name(),event:'crash',url:page.url()})))
        page.on('framenavigated',frame=>{
          if(frame===page.mainFrame())console.log('NATIVE_PAGE_LIFETIME',JSON.stringify({browser:browserType.name(),event:'navigation',url:frame.url()}))
        })
        page.on('pageerror',error=>{
          pageErrors.push(error.message)
          console.error('native browser page error',browserType.name(),error.stack??error.message)
        })
        if(process.env.NATIVE_VITE8_BUNDLE_DIR){
          page.on('console',message=>{
            const text=message.text()
            if(process.env.NATIVE_CHILD_STDIO==='1'&&(text.includes('A'.repeat(128))||text.includes('B'.repeat(128))||text.includes('fork ignored marker')))ignoredChildOutputLeaked=true
            if(text.startsWith('DECLARED_BUILD_CLI '))console.log(text)
            else if(text.startsWith('NATIVE_EXAMPLE_TRACE '))console.log(browserType.name(),text)
            else if(text.startsWith('VITEST_COMMAND_STAGE '))console.log(browserType.name(),text)
            else if(['error','warning'].includes(message.type()))console.log('vite8 browser console',browserType.name(),message.type(),text)
          })
          page.on('requestfailed',request=>console.log('vite8 failed request',browserType.name(),request.url(),request.failure()))
          page.on('response',response=>{if(response.status()>=400)void response.text().then(body=>console.log('vite8 HTTP error',browserType.name(),response.status(),response.url(),body.slice(0,500))).catch(()=>{})})
        }
        await page.goto(server.resolvedUrls.local[0]+'native-dev-preview')
        await page.evaluate(url=>{window.nativeWorkerURL=url},process.env.NATIVE_RENAMED_ENGINE==='1'?'/vite-runtime/selected-engine.js?probe=preserved':process.env.NATIVE_PORTABLE_PATH==='1'?'/portable/runtime/engine.js':'/vite-runtime/engine.js')
        assert.equal(await page.evaluate(async()=>{
          const {NativeDevServer}=await import('/native-sdk/index.js')
          try{new NativeDevServer({}, {workerURL:'https://example.com/engine.js'});return false}
          catch(error){return String(error).includes('application origin')}
        }),true)
        if(process.env.NATIVE_PREPARE_RUNTIME==='1'){
          const result=await page.evaluate(async()=>{
            const {prepareNativeRuntime,NativeDevServer}=await import('/native-sdk/index.js')
            const files={
              '/app/package.json':JSON.stringify({type:'module',dependencies:{vite:'8.3.1',rolldown:'1.2.11',lightningcss:'1.33.0','is-number':'7.0.0'}}),
              '/app/server.js':'import isNumber from "is-number";export default {fetch(){return new Response(isNumber(42)?"prepared":"wrong")}}',
            }
            const prepared=await prepareNativeRuntime(files,[{workerURL:window.nativeWorkerURL,toolchain:{vite:'8.3.1',rolldown:'1.2.11'}}])
            const dev=new NativeDevServer(prepared.files,{workerURL:prepared.candidate.workerURL,lock:prepared.lock,entry:'server.js',serveFetchEntry:true})
            try{
              const port=await dev.ready
              const response=await dev.fetch(new Request('http://localhost:'+port+'/'))
              const actual=new TextDecoder().decode(await dev.readFile('/app/package-lock.json'))
              return {status:response.status,body:await response.text(),sameLock:actual===prepared.files['/app/package-lock.json'],inputUnchanged:!Object.hasOwn(files,'/app/package-lock.json'),vite:prepared.lock.packages.find(pkg=>pkg.installPath==='/node_modules/vite')?.version,rolldown:prepared.lock.packages.find(pkg=>pkg.installPath==='/node_modules/rolldown')?.version}
            }finally{await dev.dispose()}
          })
          assert.deepEqual(result,{status:200,body:'prepared',sameLock:true,inputUnchanged:true,vite:'8.3.1',rolldown:'1.2.11'},browserType.name())
          assert.deepEqual(pageErrors,[],browserType.name())
          console.log(JSON.stringify({browser:browserType.name(),preparedRuntime:true,passed:true}))
          continue
        }
        if(process.env.NATIVE_RUNTIME_SELECTION_ONLY==='1'){
          const failures=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            return ['null','false','42','"invalid"','[]'].map(source=>{
              try{
                new NativeDevServer({
                  '/app/npm-shrinkwrap.json':source,
                  '/app/package-lock.json':JSON.stringify({packages:{'node_modules/rolldown':{version:'1.2.11'}}}),
                },{runtimeCandidates:[{workerURL:window.nativeWorkerURL,toolchain:{vite:'8.3.1',rolldown:'1.2.11'}}]})
                return 'accepted invalid shrinkwrap'
              }catch(error){return String(error)}
            })
          })
          for(const failure of failures)assert.match(failure,/Invalid project lockfile: \/app\/npm-shrinkwrap\.json/)
          assert.deepEqual(pageErrors,[],browserType.name())
          continue
        }
        if(process.env.NATIVE_REINSTALL==='1'){
          const result=await page.evaluate(async({shrinkwrap,vite})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const options={workerURL:window.nativeWorkerURL,installCommand:'npm install',
              ...(vite?{}:{entry:'index.mjs',serveFetchEntry:true})}
            let dev=new NativeDevServer({
              '/app/package.json':JSON.stringify({name:'reinstall-test',version:'1.0.0',type:'module'}),
              '/app/index.mjs':'export default {fetch(request){if(new URL(request.url).pathname==="/stream")return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("first"));globalThis.finishRefreshStream=()=>{controller.enqueue(new TextEncoder().encode("last"));controller.close()}}}));return new Response("running")}}',
              ...(vite?{'/app/index.html':'<p>running</p>'}:{}),
              ...(shrinkwrap?{'/app/npm-shrinkwrap.json':JSON.stringify({name:'reinstall-test',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'reinstall-test',version:'1.0.0'}}}),
                '/app/package-lock.json':'{"lockfileVersion":1}'}:{}),
            },options)
            try{
              await dev.ready
              await dev.writeFile('/app/edited.txt','persisted')
              const old=dev
              await dev.writeFile('/app/package.json','{bad json')
              let failure=''
              try{await dev.reinstall(options)}catch(error){failure=String(error)}
              const oldPort=await old.ready
              const oldManifest=new TextDecoder().decode(await old.readFile('/app/package.json'))
              await dev.writeFile('/app/package.json',JSON.stringify({name:'reinstall-test',version:'1.0.0',type:'module'}))
              dev=await dev.reinstall(options)
              const currentPort=await dev.ready
              const currentManifest=new TextDecoder().decode(await dev.readFile('/app/package.json'))
              let streamReader
              if(shrinkwrap&&!vite){
                const streaming=await dev.fetch(new Request(`http://127.0.0.1:${currentPort}/stream`))
                streamReader=streaming.body.getReader()
                if(new TextDecoder().decode((await streamReader.read()).value)!=='first')throw Error('Initial streaming chunk missing')
              }
              await dev.writeFile('/app/package.json',JSON.stringify({name:'reinstall-test',version:'1.0.0',type:'module',
                dependencies:{'is-number':'7.0.0'}}))
              if(shrinkwrap){
                if(!vite)await dev.writeFile('/app/index.mjs','import isNumber from "is-number";export default {fetch(request){if(new URL(request.url).pathname==="/finish")globalThis.finishRefreshStream();return new Response(isNumber(5)?"installed":"wrong")}}')
                const install=await dev.terminalCommand('npm install')
                if(install.exitCode!==0)throw Error(`Live install failed: ${JSON.stringify(install)}`)
                if(streamReader){
                  await dev.fetch(new Request(`http://127.0.0.1:${currentPort}/finish`))
                  if(new TextDecoder().decode((await streamReader.read()).value)!=='last'||!(await streamReader.read()).done)throw Error('Refresh interrupted an existing response stream')
                  streamReader.releaseLock()
                }
              }else dev=await dev.reinstall(options)
              const installed=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/node_modules/is-number/package.json')))
              if(shrinkwrap){
                const selected=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/npm-shrinkwrap.json')))
                if(selected.packages['node_modules/is-number']?.version!=='7.0.0')throw Error('Live install did not update shrinkwrap')
                if(new TextDecoder().decode(await dev.readFile('/app/package-lock.json'))!=='{"lockfileVersion":1}')throw Error('Live install changed the fallback lock')
                const response=await dev.fetch(new Request(`http://127.0.0.1:${currentPort}/`))
                const body=await response.text()
                if(vite?!body.includes('<p>running</p>'):body!=='installed')throw Error('Live install did not keep the app working')
                if(!vite){
                  const previousLock=new TextDecoder().decode(await dev.readFile('/app/npm-shrinkwrap.json'))
                  await dev.writeFile('/app/package.json',JSON.stringify({name:'reinstall-test',version:'1.0.0',type:'module',dependencies:{'is-number':'6.0.0'}}))
                  await dev.writeFile('/app/index.mjs','import isNumber from "is-number";throw Error("refresh failure marker");export default {fetch(){return new Response(String(isNumber(5)))}}')
                  const failed=await dev.terminalCommand('npm install')
                  if(failed.exitCode===0||!failed.stderr.includes('refresh failure marker'))throw Error(`Expected refresh failure: ${JSON.stringify(failed)}`)
                  const restored=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/node_modules/is-number/package.json')))
                  if(restored.version!=='7.0.0')throw Error('Failed refresh did not restore dependency tree')
                  if(new TextDecoder().decode(await dev.readFile('/app/npm-shrinkwrap.json'))!==previousLock)throw Error('Failed refresh did not restore shrinkwrap')
                  const prior=await dev.fetch(new Request(`http://127.0.0.1:${currentPort}/`))
                  if(await prior.text()!=='installed')throw Error('Failed refresh retired the prior fetch handler')
                  await dev.writeFile('/app/index.mjs','import isNumber from "is-number";export default {fetch(){return new Response(isNumber(5)?"recovered":"wrong")}}')
                  const retry=await dev.terminalCommand('npm install')
                  if(retry.exitCode!==0)throw Error(`Refresh retry failed: ${JSON.stringify(retry)}`)
                  const retried=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/node_modules/is-number/package.json')))
                  if(retried.version!=='6.0.0')throw Error('Retry did not install the requested dependency version')
                  const recovered=await dev.fetch(new Request(`http://127.0.0.1:${currentPort}/`))
                  if(await recovered.text()!=='recovered')throw Error('Retry did not publish the repaired entry')
                  const recoveredLock=new TextDecoder().decode(await dev.readFile('/app/npm-shrinkwrap.json'))
                  await dev.writeFile('/app/package.json',JSON.stringify({name:'reinstall-test',version:'1.0.0',type:'module',dependencies:{'is-number':'7.0.0'}}))
                  await dev.writeFile('/app/index.mjs','export default {}')
                  const invalid=await dev.terminalCommand('npm install')
                  if(invalid.exitCode===0||!invalid.stderr.includes('does not export a fetch handler'))throw Error(`Expected invalid export failure: ${JSON.stringify(invalid)}`)
                  const unchanged=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/node_modules/is-number/package.json')))
                  if(unchanged.version!=='6.0.0'||new TextDecoder().decode(await dev.readFile('/app/npm-shrinkwrap.json'))!==recoveredLock)throw Error('Invalid export did not restore installed state')
                  const stillRunning=await dev.fetch(new Request(`http://127.0.0.1:${currentPort}/`))
                  if(await stillRunning.text()!=='recovered')throw Error('Invalid export replaced the working handler')
                }
              }
              return {failure,oldPortLive:oldPort>0,oldManifest,currentPortLive:currentPort>0,currentManifest,
                installed:installed.name+'@'+installed.version,
                edited:new TextDecoder().decode(await dev.readFile('/app/edited.txt'))}
            }catch(error){return {error:String(error),diagnostics:dev.diagnostics,progress:dev.progress}}
            finally{await dev.dispose()}
          },{shrinkwrap:process.env.NATIVE_REINSTALL_SHRINKWRAP==='1',vite:process.env.NATIVE_REINSTALL_VITE==='1'})
          assert.equal(result.error,undefined,`${browserType.name()} reinstall: ${JSON.stringify(result)}`)
          assert.match(result.failure,/SyntaxError:/)
          assert.doesNotMatch(result.failure,/engine\.js:/)
          assert.deepEqual({...result,failure:undefined},{failure:undefined,oldPortLive:true,oldManifest:'{bad json',currentPortLive:true,
            currentManifest:JSON.stringify({name:'reinstall-test',version:'1.0.0',type:'module'}),
            installed:'is-number@7.0.0',edited:'persisted'})
          continue
        }
        if(process.env.NATIVE_VITE8_BUNDLE_DIR)console.log('vite8 page isolation',browserType.name(),await page.evaluate(()=>crossOriginIsolated))
        if(!process.env.NATIVE_PREVIEW_ONLY){
        const result=await page.evaluate(async()=>{
          const {NativeDevServer}=await import('/native-sdk/index.js')
          const dev=new NativeDevServer({
            '/app/package.json':'{"type":"module"}',
            '/app/index.html':'<script type="module" src="/main.js"></script>',
            '/app/main.js':'if(import.meta.hot)import.meta.hot.accept();document.body.textContent="before edit"',
          },{workerURL:window.nativeWorkerURL})
          try{
            const port=await dev.ready
            const readyPort=await dev.waitForHTTPReady()
            const origin=`http://127.0.0.1:${port}`
            const html=await(await dev.fetch(new Request(origin+'/'))).text()
            const module=await(await dev.fetch(new Request(origin+'/main.js'))).text()
            const client=await(await dev.fetch(new Request(origin+'/@vite/client'))).text()
            const websocket=await dev.connectWebSocket(origin,await dev.hmrURL(),['vite-hmr'])
            const connected=await websocket.next()
            await dev.writeFile('/app/main.js','if(import.meta.hot)import.meta.hot.accept();document.body.textContent="after edit"')
            const frame=await Promise.race([websocket.next(),new Promise((_,reject)=>setTimeout(()=>reject(Error('HMR timeout')),5000))])
            const updated=await(await dev.fetch(new Request(origin+'/main.js'))).text()
            const outsideWriteRejected=await dev.writeFile('/dist/client/client.mjs','tampered').then(()=>false,()=>true)
            const outsideReadRejected=await dev.readFile('/dist/client/client.mjs').then(()=>false,()=>true)
            await websocket.dispose()
            return {port,readyPort,html:html.includes('/main.js'),module:module.includes('before edit'),clientExport:client.includes('createHotContext'),updated:updated.includes('after edit'),connected:connected?.type==='text'&&JSON.parse(connected.data).type==='connected',frame:frame?.type==='text'&&JSON.parse(frame.data).type,outsideWriteRejected,outsideReadRejected}
          }finally{await dev.dispose()}
        })
        assert.equal(result.html,true)
        assert.equal(result.readyPort,result.port)
        assert.equal(result.module,true)
        assert.equal(result.clientExport,true)
        assert.equal(result.updated,true)
        assert.equal(result.connected,true)
        assert.equal(result.frame,'update')
        assert.equal(result.outsideWriteRejected,true)
        assert.equal(result.outsideReadRejected,true)
        if(process.env.NATIVE_START_DROP_TEST==='1'){
          const recovered=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const OriginalWorker=window.Worker
            let dropped=false
            window.Worker=class extends OriginalWorker{
              set onmessage(handler){
                super.onmessage=event=>{
                  if(!dropped&&event.data?.id===1&&event.data?.ok===true){dropped=true;return}
                  handler(event)
                }
              }
              get onmessage(){return super.onmessage}
            }
            let dev
            try{
              dev=new NativeDevServer({
                '/app/package.json':'{"type":"module"}',
                '/app/index.html':'<!doctype html><html><head></head><body>recover</body></html>',
              },{workerURL:window.nativeWorkerURL})
            }finally{window.Worker=OriginalWorker}
            try{
              const port=await dev.ready
              const body=await(await dev.fetch(new Request(`http://127.0.0.1:${port}/`))).text()
              return {dropped,port,body,reconciled:dev.progress.some(event=>event.phase==='start-result-reconciled')}
            }finally{await dev.dispose()}
          })
          assert.equal(recovered.dropped,true,browserType.name())
          assert.ok(recovered.port>0,browserType.name())
          assert.match(recovered.body,/recover/,browserType.name())
          assert.equal(recovered.reconciled,true,browserType.name())
        }
        const remounted=await page.evaluate(async()=>{
          const {NativeDevServer}=await import('/native-sdk/index.js')
          const dev=new NativeDevServer({
            '/project/package.json':'{"type":"module"}',
            '/project/index.html':'<p>mounted project</p>',
            '/project/executable.sh':'echo ready',
            '/project/vite.config.js':`import {mkdirSync,chmodSync,symlinkSync} from 'node:fs';
              if(process.env.CREATE_CHECKPOINT_SHAPE==='1'){
                mkdirSync('/app/empty');chmodSync('/app/empty',0o700);
                chmodSync('/app/executable.sh',0o750);
                symlinkSync('note.txt','/app/note-link');
                symlinkSync('missing','/app/dangling-link');
              }
              export default {};`,
          },{workerURL:window.nativeWorkerURL,workspaceRoot:'/project',env:{CREATE_CHECKPOINT_SHAPE:'1'}})
          try{
            const port=await dev.ready
            const html=await(await dev.fetch(new Request(`http://127.0.0.1:${port}/`))).text()
            await dev.writeFile('/project/note.txt','saved')
            const snapshot=await dev.snapshot()
            const shape=await dev.snapshotWorkspace()
            const checkpoint=await dev.saveCheckpoint('native-mounted-project-test')
            const outsideRejected=await dev.readFile('/app/note.txt').then(()=>false,()=>true)
            return {html:html.includes('mounted project'),snapshot:Object.hasOwn(snapshot,'/project/note.txt'),
              note:new TextDecoder().decode(await dev.readFile('/project/note.txt')),outsideRejected,checkpoint:checkpoint.key,
              snapshotVersion:checkpoint.snapshotVersion,emptyDirectory:shape.directories.includes('/project/empty'),
              emptyMode:shape.directoryModes['/project/empty'],fileMode:shape.fileModes['/project/executable.sh'],
              links:[shape.symlinks['/project/note-link'],shape.symlinks['/project/dangling-link']]}
          }finally{await dev.dispose()}
        })
        assert.deepEqual(remounted,{html:true,snapshot:true,note:'saved',outsideRejected:true,checkpoint:'native-mounted-project-test',snapshotVersion:5,
          emptyDirectory:true,emptyMode:0o700,fileMode:0o750,links:['note.txt','missing']})
        const observed=await page.evaluate(async()=>{
          const {NativeDevServer}=await import('/native-sdk/index.js')
          const dev=new NativeDevServer({
            '/app/package.json':'{"type":"module"}',
            '/app/main.mjs':`process.stdout.write('guest stdout\\n');process.stderr.write('guest stderr\\n');
              process.stdout.write(Uint8Array.from([0xe2]));process.stdout.write(Uint8Array.from([0x82,0xac]));`,
          },{workerURL:window.nativeWorkerURL,entry:'main.mjs'})
          const events=[]
          const unsubscribe=dev.subscribeEvents(event=>events.push(event))
          try{
            await dev.ready
            return {stdout:events.some(event=>event.type==='output'&&event.stream==='stdout'&&event.text.includes('guest stdout')),
              stderr:events.some(event=>event.type==='output'&&event.stream==='stderr'&&event.text.includes('guest stderr')),
              unicode:events.some(event=>event.type==='output'&&event.stream==='stdout'&&event.text.includes('€')),
              progress:events.some(event=>event.type==='progress'&&event.phase==='entry-ready')}
          }finally{unsubscribe();await dev.dispose()}
        })
        assert.deepEqual(observed,{stdout:true,stderr:true,unicode:true,progress:true})
        const cancelled=await page.evaluate(async()=>{
          const {NativeDevServer}=await import('/native-sdk/index.js')
          const dev=new NativeDevServer({
            '/app/package.json':'{"type":"module"}',
            '/app/main.mjs':'for(;;){}',
          },{workerURL:window.nativeWorkerURL,entry:'main.mjs'})
          const ready=dev.ready.then(()=>false,error=>String(error).includes('cancelled by host'))
          await new Promise(resolve=>setTimeout(resolve,150))
          dev.close(Error('cancelled by host'))
          return ready
        })
        assert.equal(cancelled,true)
        await page.reload()
        await page.evaluate(url=>{window.nativeWorkerURL=url},process.env.NATIVE_RENAMED_ENGINE==='1'?'/vite-runtime/selected-engine.js?probe=preserved':process.env.NATIVE_PORTABLE_PATH==='1'?'/portable/runtime/engine.js':'/vite-runtime/engine.js')
        const resumed=await page.evaluate(async()=>{
          const {NativeDevServer}=await import('/native-sdk/index.js')
          const dev=await NativeDevServer.restoreCheckpoint('native-mounted-project-test',
            {workerURL:window.nativeWorkerURL,workspaceRoot:'/project'})
          try{
            const port=await dev.ready
            const note=new TextDecoder().decode(await dev.readFile('/project/note.txt'))
            const entries=await dev.listDirectory('/project')
            const commands=await dev.listTerminalCommands()
            let outsideRejected=false
            try{await dev.listDirectory('/outside')}catch{outsideRejected=true}
            const shape=await dev.snapshotWorkspace()
            const response=await dev.fetch(new Request(`http://127.0.0.1:${port}/`))
            return {note,status:response.status,installed:dev.progress.some(item=>item.phase==='dependencies-install-started'),
              listedNote:entries.some(entry=>entry.name==='note.txt'&&entry.type==='file'),
              listedEmpty:entries.some(entry=>entry.name==='empty'&&entry.type==='directory'),outsideRejected,
              listedCommands:['cd','node','pnpm'].every(command=>commands.includes(command)),
              emptyDirectory:shape.directories.includes('/project/empty'),emptyMode:shape.directoryModes['/project/empty'],
              fileMode:shape.fileModes['/project/executable.sh'],
              links:[shape.symlinks['/project/note-link'],shape.symlinks['/project/dangling-link']],
              linkedNote:new TextDecoder().decode(await dev.readFile('/project/note-link'))}
          }finally{await dev.dispose()}
        })
        assert.deepEqual(resumed,{note:'saved',status:200,installed:false,listedNote:true,listedEmpty:true,outsideRejected:true,listedCommands:true,emptyDirectory:true,emptyMode:0o700,
          fileMode:0o750,links:['note.txt','missing'],linkedNote:'saved'})
        if(process.env.NATIVE_MULTI_PORT==='1'){
          const multiple=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/index.html':'<p>vite primary</p>',
              '/app/vite.config.ts':`import {createServer} from 'node:http';
                import {createHash} from 'node:crypto';
                const auxiliary=createServer((_request,response)=>response.end('auxiliary service'));
                auxiliary.on('upgrade',(request,socket)=>{
                  const key=request.headers['sec-websocket-key'];
                  const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
                  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');
                  socket.write(Buffer.concat([Buffer.from([0x81,16]),Buffer.from('auxiliary socket')]));
                });
                auxiliary.listen(3000);
                export default {server:{port:3002},plugins:[{name:'auxiliary-service',configureServer(server){
                  server.httpServer.on('close',()=>auxiliary.close());
                }}]};`,
            },{workerURL:window.nativeWorkerURL})
            try{
              const primary=await dev.ready
              const ports=await dev.ports()
              const primaryResponse=await dev.fetch(new Request(`http://127.0.0.1:${primary}/`))
              const auxiliaryResponse=await dev.fetch(new Request('http://127.0.0.1:3000/'))
              const websocket=await dev.connectWebSocket('http://127.0.0.1:3000','ws://127.0.0.1:3000/')
              const frame=await websocket.next()
              await websocket.dispose()
              return {primary,ports,primaryBody:await primaryResponse.text(),auxiliaryBody:await auxiliaryResponse.text(),frame}
            }finally{await dev.dispose()}
          })
          assert.equal(multiple.primary,3002)
          assert.ok(multiple.ports.includes(3000)&&multiple.ports.includes(3002))
          assert.ok(multiple.primaryBody.includes('vite primary'))
          assert.equal(multiple.auxiliaryBody,'auxiliary service')
          assert.deepEqual(multiple.frame,{type:'text',data:'auxiliary socket'})
        }
        if(process.env.NATIVE_APP_FORK==='1'){
          const result=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer(files,{workerURL:window.nativeWorkerURL,entry:'app-fork-parent.mjs',serveFetchEntry:true,installDependencies:false})
            try{
              const port=await dev.ready
              const response=await dev.fetch(new Request('http://localhost:'+port+'/'))
              return {status:response.status,result:await response.json()}
            }finally{await dev.dispose()}
          },nativeAppForkFiles)
          assert.deepEqual(result,{status:200,result:nativeAppForkExpected},browserType.name())
          console.log(browserType.name(),'app fork default passed')
          continue
        }
        if(process.env.NATIVE_FORK_DEFAULTS==='1'){
          const result=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({...files,'/app/index.mjs':'export default {fetch(){return new Response("ready")}}'},
              {workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true,installDependencies:false})
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
            try{
              await dev.ready
              const command=await dev.terminalCommand('node input-fork-parent.cjs < input.bin','/app',undefined,controller.signal)
              return {code:command.exitCode,stdout:command.stdout.trim(),stderr:command.stderr}
            }finally{clearTimeout(timer);await dev.dispose()}
          },nativeInheritedInputFiles)
          assert.deepEqual(result,{code:0,stdout:'default-out\nexplicit-out\n'+JSON.stringify(nativeForkDefaultExpected),stderr:'default-err\nexplicit-err\n'},`${browserType.name()} fork defaults: ${JSON.stringify(result)}`)
          console.log(browserType.name(),'fork defaults passed')
          continue
        }
        if(process.env.NATIVE_CHILD_INHERITED_INPUT==='1'){
          const result=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({...files,'/app/index.mjs':'export default {fetch(){return new Response("ready")}}'},
              {workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true,installDependencies:false})
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
            try{
              await dev.ready
              const results=[]
              for(const [entry,input] of [['input-parent.cjs','input.bin'],['input-nested.cjs','input.bin'],['input-large-parent.cjs','input-large.bin'],['input-competing-parent.cjs','input-large.bin']]){
                const command=await dev.terminalCommand('node '+entry+' < '+input,'/app',undefined,controller.signal)
                results.push({code:command.exitCode,stdout:command.stdout.trim(),stderr:command.stderr})
              }
              const channel=new MessageChannel();let output='',sent=false
              try{
                const command=await dev.terminalCommand('node input-cancel-parent.cjs','/app',text=>{
                  output+=text
                  if(!sent&&output.includes('READY\n')){
                    sent=true;channel.port1.postMessage({type:'data',bytes:new Uint8Array([0,128,255,10,65])});channel.port1.postMessage({type:'end'})
                  }
                },controller.signal,channel.port2)
                results.push({code:command.exitCode,stdout:output.trim(),stderr:command.stderr})
              }finally{channel.port1.close()}
              return results
            }finally{clearTimeout(timer);await dev.dispose()}
          },process.env.NATIVE_INPUT_CANCEL_TRACE==='1'?{...nativeInheritedInputFiles,'/app/input-cancel-parent.cjs':"process.env.NATIVE_INPUT_CANCEL_TRACE='1';"+nativeInheritedInputFiles['/app/input-cancel-parent.cjs']}:nativeInheritedInputFiles)
          assert.deepEqual(result,[...[nativeInheritedInputExpected,nativeInheritedInputExpected,nativeInheritedLargeInputExpected,nativeInheritedCompetingExpected].map(expected=>({code:0,stdout:JSON.stringify(expected),stderr:''})),{code:0,stdout:'READY\n'+JSON.stringify(nativeInheritedCancelledExpected),stderr:''}],`${browserType.name()} inherited input: ${JSON.stringify(result)}`)
          console.log(browserType.name(),'inherited child input passed')
          continue
        }
        if(process.env.NATIVE_WORKER_PRELOADS==='1'){
          const result=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({...files,'/app/index.mjs':'export default {fetch(){return new Response("ready")}}'},
              {workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true,installDependencies:false})
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
            try{
              await dev.ready
              const results=[]
              for(const line of ['node preload-parent.cjs','node --require ./preload-first.cjs --import ./preload-second.mjs preload-inherited-parent.cjs','node --require ./preload-first.cjs --import ./preload-second.mjs preload-nested-parent.cjs']){
                const command=await dev.terminalCommand(line,'/app',undefined,controller.signal)
                results.push({code:command.exitCode,stdout:command.stdout.trim(),stderr:command.stderr})
              }
              return results
            }finally{clearTimeout(timer);await dev.dispose()}
          },nativeWorkerPreloadFiles)
          assert.deepEqual(result,[nativeWorkerPreloadExpected,nativeWorkerPreloadExpected,nativeWorkerNestedPreloadExpected].map(value=>({code:0,stdout:JSON.stringify(value),stderr:''})),`${browserType.name()} worker preloads: ${JSON.stringify(result)}`)
          console.log(browserType.name(),'Worker preloads passed')
          continue
        }
        if(process.env.NATIVE_WORKER_EVAL==='1'||process.env.NATIVE_WORKER_DATA_URL==='1'){
          const result=await page.evaluate(async({source,browserModules})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({'/app/index.mjs':'export default {fetch(){return new Response("ready")}}','/app/worker-eval-parent.cjs':source},
              {workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true,installDependencies:false})
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
            try{
              await dev.ready
              const command=await dev.terminalCommand((browserModules?'NATIVE_BROWSER_MODULES=1 ':'')+'node worker-eval-parent.cjs','/app',undefined,controller.signal)
              return {code:command.exitCode,stdout:command.stdout.trim(),stderr:command.stderr}
            }finally{clearTimeout(timer);await dev.dispose()}
          },{source:process.env.NATIVE_WORKER_DATA_URL==='1'?nativeWorkerDataParent:nativeWorkerEvalParent,browserModules:process.env.NATIVE_BROWSER_MODULES==='1'})
          assert.deepEqual(result,{code:0,stdout:JSON.stringify(process.env.NATIVE_WORKER_DATA_URL==='1'?nativeWorkerDataExpected:nativeWorkerEvalExpected),stderr:''},`${browserType.name()} worker source: ${JSON.stringify(result)}`)
          console.log(browserType.name(),process.env.NATIVE_WORKER_DATA_URL==='1'?'data URL Worker passed':'inline Worker eval passed')
          continue
        }
        if(process.env.NATIVE_DATA_MODULE_APP==='1'){
          const result=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const data='data:text/javascript,'+encodeURIComponent('import {basename} from "node:path";export let count=0;export function increment(){count++};export const name=basename("/app/file.txt");export const url=import.meta.url')
            const source=`import {count,increment,name,url} from ${JSON.stringify(data)};
              increment();const first=await import(${JSON.stringify(data)}),second=await import(${JSON.stringify(data)});
              export default {fetch(){return Response.json({count,name,url,same:first===second})}}`
            const dev=new NativeDevServer({'/app/index.mjs':source},{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true,installDependencies:false})
            try{
              const port=await dev.ready
              const response=await dev.fetch(new Request('http://localhost:'+port+'/'))
              return {status:response.status,result:await response.json(),expectedURL:data}
            }finally{await dev.dispose()}
          })
          assert.deepEqual(result,{status:200,result:{count:1,name:'file.txt',url:result.expectedURL,same:true},expectedURL:result.expectedURL},browserType.name())
          console.log(browserType.name(),'app data modules passed')
          continue
        }
        if(process.env.NATIVE_VM_GLOBAL==='1'){
          const result=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const source='import vm from "node:vm";const receiver=vm.runInThisContext("this===globalThis");const declaration=vm.runInThisContext("var __nativeVmGlobal=41;__nativeVmGlobal");const across=new vm.Script("__nativeVmGlobal+1",{filename:"/app/vm-global.js"}).runInThisContext();export default {fetch(){return Response.json({receiver,declaration,across})}}'
            const dev=new NativeDevServer({'/app/index.mjs':source},{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true,installDependencies:false})
            try{
              const port=await dev.ready
              const response=await dev.fetch(new Request('http://localhost:'+port+'/'))
              return {status:response.status,result:await response.json()}
            }finally{await dev.dispose()}
          })
          assert.deepEqual(result,{status:200,result:{receiver:true,declaration:41,across:42}},browserType.name())
          console.log(browserType.name(),'VM global execution passed')
          continue
        }
        if(!realExample&&process.env.NATIVE_THREAD_WATCHFILE!=='1'&&process.env.NATIVE_THREAD_BASIC!=='1'&&process.env.NATIVE_THREAD_LIVE_FILES!=='1'&&process.env.NATIVE_THREAD_COMMAND!=='1'&&
          process.env.NATIVE_TERMINAL_NODE!=='1'&&process.env.NATIVE_TERMINAL_PACKAGE!=='1'&&
          process.env.NATIVE_TERMINAL_BIN!=='1'&&process.env.NATIVE_TERMINAL_SERVER!=='1'&&process.env.NATIVE_TERMINAL_VITEST!=='1'){
        const installed=await page.evaluate(async()=>{
          const {NativeDevServer}=await import('/native-sdk/index.js')
          const lock=await(await fetch('/start-fixture/browser-build-lock.json')).json()
          const selected=lock.packages.find(pkg=>pkg.installPath==='/node_modules/@babel/code-frame')
          if(!selected)throw Error('Pinned package missing')
          const dev=new NativeDevServer({'/app/index.html':'<!doctype html><html><head></head><body>ready</body></html>'},{workerURL:window.nativeWorkerURL,lock:{version:1,packages:[selected]}})
          try{
            const port=await dev.ready
            const path='/app/node_modules/@babel/code-frame/package.json'
            const packageName=JSON.parse(new TextDecoder().decode(await dev.readFile(path))).name
            const snapshot=await dev.snapshot()
            await dev.saveCheckpoint('native-installed-package-test')
            const response=await dev.fetch(new Request(`http://127.0.0.1:${port}/`))
            const restored=await NativeDevServer.restoreCheckpoint('native-installed-package-test',
              {workerURL:window.nativeWorkerURL})
            try{
              const restoredPort=await restored.ready
              const restoredPackage=JSON.parse(new TextDecoder().decode(await restored.readFile(path))).name
              const restoredResponse=await restored.fetch(new Request(`http://127.0.0.1:${restoredPort}/`))
              return {packageName,snapshotContainsPackage:Object.hasOwn(snapshot,path),htmlStatus:response.status,
                restoredPackage,restoredStatus:restoredResponse.status,
                restoredWithoutInstall:!restored.progress.some(item=>item.phase==='dependencies-install-started')}
            }finally{await restored.dispose()}
          }catch(error){return {error:String(error),diagnostics:dev.diagnostics,progress:dev.progress}}
          finally{await dev.dispose()}
        })
        assert.deepEqual(installed,{packageName:'@babel/code-frame',snapshotContainsPackage:true,htmlStatus:200,
          restoredPackage:'@babel/code-frame',restoredStatus:200,restoredWithoutInstall:true})
        }
        if(process.env.NATIVE_THREAD_WATCHFILE==='1'){
          const result=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/watch-target.txt':'before',
              '/app/main.mjs':`import {Worker} from 'node:worker_threads';import {writeFileSync,unlinkSync} from 'node:fs';
                const worker=new Worker('/app/watch.mjs');
                worker.on('message',message=>{if(message==='ready')writeFileSync('/app/watch-target.txt','updated by owner');
                  else if(message==='updated')unlinkSync('/app/watch-target.txt');
                  else if(message==='deleted')writeFileSync('/app/watch-target.txt','recreated');
                  else writeFileSync('/app/result.json',JSON.stringify(message))});
                worker.on('error',error=>writeFileSync('/app/failure.txt',String(error)));`,
              '/app/watch.mjs':`import {watchFile,unwatchFile,readFileSync} from 'node:fs';import {parentPort} from 'node:worker_threads';
                const timeout=setTimeout(()=>{unwatchFile('/app/watch-target.txt');throw Error('Live watchFile did not observe owner edit')},1500);
                const events=[];
                watchFile('/app/watch-target.txt',{interval:20},(current,previous)=>{
                  events.push([current.size,previous.size]);
                  if(current.nlink===0){parentPort.postMessage('deleted');return}
                  if(readFileSync('/app/watch-target.txt','utf8')==='updated by owner'){parentPort.postMessage('updated');return}
                  clearTimeout(timeout);unwatchFile('/app/watch-target.txt');
                  parentPort.postMessage({changed:true,events});
                });parentPort.postMessage('ready');`,
            },{workerURL:window.nativeWorkerURL,entry:'main.mjs'})
            try{
              await dev.ready
              for(let attempt=0;attempt<100;attempt++){
                try{return JSON.parse(new TextDecoder().decode(await dev.readFile('/app/result.json')))}catch{}
                try{return {failure:new TextDecoder().decode(await dev.readFile('/app/failure.txt'))}}catch{}
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              return {timeout:true}
            }finally{await dev.dispose()}
          })
          assert.deepEqual(result,{changed:true,events:[[16,6],[0,16],[9,16]]})
          continue
        }
        if(process.env.NATIVE_OWNER_FATAL_CAPTURE==='1'){
          const fatal=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({'/app/main.mjs':`setTimeout(()=>{
              throw Object.assign(Error('owner reset probe'),{code:'ECONNRESET'})
            },100);export default {fetch(){return new Response('ready')}}`},
              {workerURL:window.nativeWorkerURL,entry:'main.mjs',serveFetchEntry:true})
            try{
              await dev.ready.catch(()=>{})
              for(let attempt=0;attempt<100;attempt++){
                const result=dev.diagnostics.find(item=>item.error.includes('owner reset probe'))
                if(result)return result
                await new Promise(resolve=>setTimeout(resolve,50))
              }
              return {error:'No fatal diagnostic delivered',diagnostics:dev.diagnostics}
            }finally{await dev.dispose()}
          })
          assert.match(fatal.error,/owner reset probe/)
          assert.ok(Array.isArray(fatal.diagnostic?.handles),'Owner fatal error must deliver socket metadata')
          continue
        }
        if(process.env.NATIVE_THREAD_BASIC==='1'){
          const thread=await page.evaluate(async(resetCapture)=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/main.mjs':`import {Worker} from 'node:worker_threads';import {writeFileSync} from 'node:fs';
                writeFileSync('/app/started.txt','yes');
                const initialBytes=new Uint8Array([8,9]),initialData={answer:42,bytes:initialBytes};
                const worker=new Worker('/app/child.mjs',{workerData:initialData,transferList:[initialBytes.buffer]});
                if(initialBytes.byteLength!==0)throw Error('Constructor buffer was not detached');
                initialData.answer=99;
                worker.on('online',()=>writeFileSync('/app/online.txt','yes'));
                worker.on('message',message=>writeFileSync('/app/result.json',JSON.stringify(message)));
                worker.on('error',error=>writeFileSync('/app/error.txt',String(error)));
                worker.on('exit',code=>writeFileSync('/app/exit.txt',String(code)));
                const transfer=new Worker('/app/transfer.mjs');
                const bytes=new Uint8Array([4,5,6]);
                transfer.postMessage({bytes},[bytes.buffer]);
                if(bytes.byteLength!==0)throw Error('Queued buffer was not detached');
                transfer.on('message',message=>writeFileSync('/app/transfer.json',JSON.stringify(message)));
                transfer.on('error',error=>writeFileSync('/app/transfer-error.txt',String(error)));
                const failed=new Worker('/app/failing.mjs');
                failed.on('error',error=>{writeFileSync('/app/failure.txt',String(error));
                  writeFileSync('/app/failure-diagnostic.json',JSON.stringify(error.diagnostic??null))});
                failed.on('exit',code=>writeFileSync('/app/failure-exit.txt',String(code)));`,
              '/app/child.mjs':`import {parentPort,workerData,isMainThread} from 'node:worker_threads';
                import {writeFileSync} from 'node:fs';
                parentPort.ref();parentPort.on('close',()=>writeFileSync('/app/child-close.txt','closed'));
                setTimeout(()=>{parentPort.postMessage({answer:workerData.answer,bytes:[...workerData.bytes],child:!isMainThread});
                  parentPort.close();parentPort.close()},20);`,
              '/app/failing.mjs':resetCapture
                ?`setTimeout(()=>{throw Object.assign(Error('worker rejection probe'),{code:'ECONNRESET'})},10);`
                :`Promise.resolve().then(()=>{throw Error('worker rejection probe')});`,
              '/app/transfer.mjs':`import {parentPort} from 'node:worker_threads';
                parentPort.once('message',message=>{
                  const values=[...message.bytes],buffer=new Uint8Array([7,8]);
                  parentPort.postMessage({values,buffer},[buffer.buffer]);
                  if(buffer.byteLength!==0)throw Error('Reply buffer was not detached');
                });`,
            },{workerURL:window.nativeWorkerURL,entry:'main.mjs'})
            try{
              await dev.ready
              for(let attempt=0;attempt<100;attempt++){
                try{return {result:JSON.parse(new TextDecoder().decode(await dev.readFile('/app/result.json'))),
                  exit:new TextDecoder().decode(await dev.readFile('/app/exit.txt')),
                  closed:new TextDecoder().decode(await dev.readFile('/app/child-close.txt')),
                  failure:new TextDecoder().decode(await dev.readFile('/app/failure.txt')),
                  failureExit:new TextDecoder().decode(await dev.readFile('/app/failure-exit.txt')),
                  failureDiagnostic:JSON.parse(new TextDecoder().decode(await dev.readFile('/app/failure-diagnostic.json'))),
                  transfer:JSON.parse(new TextDecoder().decode(await dev.readFile('/app/transfer.json'))),
                  diagnostics:dev.diagnostics}}
                catch{await new Promise(resolve=>setTimeout(resolve,100))}
              }
              let snapshot
              try{snapshot=await dev.snapshot()}
              catch(error){return {error:String(error),diagnostics:dev.diagnostics,progress:dev.progress}}
              return {timeout:true,diagnostics:dev.diagnostics,files:Object.fromEntries(
                Object.entries(snapshot).filter(([path])=>/\/(started|online|error|exit)\.txt$/.test(path)).map(([path,bytes])=>[path,new TextDecoder().decode(bytes)]))}
            }finally{await dev.dispose()}
          },process.env.NATIVE_RESET_CAPTURE==='1')
          assert.deepEqual(thread.result,{answer:42,bytes:[8,9],child:true},`${browserType.name()} native thread: ${JSON.stringify(thread)}`)
          assert.equal(thread.exit,'0')
          assert.equal(thread.closed,'closed')
          assert.match(thread.failure,/worker rejection probe/)
          assert.equal(thread.failureExit,'1')
          assert.deepEqual(thread.transfer,{values:[4,5,6],buffer:{0:7,1:8}})
          if(process.env.NATIVE_RESET_CAPTURE==='1')
            assert.ok(Array.isArray(thread.failureDiagnostic?.handles),'Fatal error must carry socket metadata to its parent')
          continue
        }
        if(process.env.NATIVE_THREAD_LIVE_FILES==='1'){
          const thread=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/main.mjs':`import {Worker} from 'node:worker_threads';import {writeFileSync,readFileSync} from 'node:fs';
                const worker=new Worker('/app/child.mjs');
                worker.on('message',message=>{
                  if(message==='ready'){
                    writeFileSync('/app/late.txt','written after worker spawn');
                    writeFileSync('/app/late-big.bin',new Uint8Array(100000).fill(65));
                    writeFileSync('/app/late-module.mjs','export default 43');
                    worker.postMessage('go');return
                  }
                  if(message?.error){writeFileSync('/app/result.json',JSON.stringify({child:message}));return}
                  writeFileSync('/app/result.json',JSON.stringify({child:message,parentRead:readFileSync('/app/child.txt','utf8'),
                    parentBig:readFileSync('/app/child-big.bin').length,
                    parentPromiseRead:readFileSync('/app/created/renamed.txt','utf8')}))
                });
                worker.on('error',error=>writeFileSync('/app/error.txt',String(error)));`,
              '/app/child.mjs':`import {parentPort} from 'node:worker_threads';import {readFileSync,writeFileSync} from 'node:fs';
                import {readFile as readAsync,writeFile as writeAsync,mkdir as mkdirAsync,readdir as readdirAsync,
                  stat as statAsync,rename as renameAsync,unlink as unlinkAsync} from 'node:fs/promises';
                parentPort.on('message',async message=>{
                  if(message!=='go')return;
                  try{
                    const value=readFileSync('/app/late.txt','utf8');
                    const module=await import('./late-module.mjs');
                    writeFileSync('/app/child.txt',value+' and returned');
                    writeFileSync('/app/child-big.bin',new Uint8Array(100000).fill(66));
                    await mkdirAsync('/app/created');
                    await writeAsync('/app/created/async.txt',await readAsync('/app/late.txt','utf8'));
                    const entries=await readdirAsync('/app/created');
                    const size=(await statAsync('/app/created/async.txt')).size;
                    await renameAsync('/app/created/async.txt','/app/created/renamed.txt');
                    await writeAsync('/app/created/remove.txt','remove');
                    await unlinkAsync('/app/created/remove.txt');
                    parentPort.postMessage({value,lateModule:module.default,childBig:readFileSync('/app/late-big.bin').length,
                      asyncEntries:entries,asyncSize:size});
                  }catch(error){parentPort.postMessage({error:String(error)})}
                });
                parentPort.postMessage('ready');`,
            },{workerURL:window.nativeWorkerURL,entry:'main.mjs'})
            try{
              await dev.ready
              for(let attempt=0;attempt<150;attempt++){
                try{return {result:JSON.parse(new TextDecoder().decode(await dev.readFile('/app/result.json'))),diagnostics:dev.diagnostics}}
                catch{await new Promise(resolve=>setTimeout(resolve,100))}
              }
              let snapshot
              try{snapshot=await dev.snapshot()}
              catch(error){return {error:String(error),diagnostics:dev.diagnostics,progress:dev.progress}}
              return {timeout:true,diagnostics:dev.diagnostics,files:Object.fromEntries(
                Object.entries(snapshot).filter(([path])=>/\/(?:late|child|error)\.txt$/.test(path)).map(([path,bytes])=>[path,new TextDecoder().decode(bytes)]))}
            }finally{await dev.dispose()}
          })
          assert.deepEqual(thread.result,{child:{value:'written after worker spawn',lateModule:43,childBig:100000,
            asyncEntries:['async.txt'],asyncSize:26},
            parentRead:'written after worker spawn and returned',parentBig:100000,
            parentPromiseRead:'written after worker spawn'},
            `${browserType.name()} live native thread files: ${JSON.stringify(thread)}`)
          continue
        }
        if(process.env.NATIVE_CHILD_STDIO==='1'){
          const result=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({...files,'/app/index.mjs':'export default {fetch(){return new Response("ready")}}'},
              {workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
            const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45000)
            try{
              await dev.ready
              const command=await dev.terminalCommand('node stdio-main.cjs','/app',undefined,controller.signal)
              let result=null
              try{result=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/stdio-result.json')))}catch{}
              return {code:command.exitCode,stderr:command.stderr,result}
            }finally{clearTimeout(timeout);await dev.dispose()}
          },nativeChildStdioFiles)
          assert.deepEqual(result,{code:0,stderr:'',result:nativeChildStdioExpected},`${browserType.name()} child stdio: ${JSON.stringify(result)}`)
          assert.equal(ignoredChildOutputLeaked,false,`${browserType.name()} ignored child output leaked to browser console`)
          console.log(JSON.stringify({browser:browserType.name(),childStdio:25,ignoredConsoleOutput:false,passed:true}))
          continue
        }
        if(process.env.NATIVE_TOP_LEVEL_AWAIT==='1'){
          const repeats=Number(process.env.NATIVE_TOP_LEVEL_AWAIT_REPEATS??1)
          assert.ok(Number.isInteger(repeats)&&repeats>=1&&repeats<=20,'Top-level await repeats must be 1..20')
          const result=await page.evaluate(async({repeats,fileURLs})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const cases=[
              ['unresolved.mjs','console.log("started"); await new Promise(()=>{})',13,'started\n'],
              ['timer.mjs','setTimeout(()=>console.log("timer"),20); console.log("started"); await new Promise(()=>{})',13,'started\ntimer\n'],
              ['unref.mjs','setInterval(()=>{},1000).unref(); console.log("started"); await new Promise(()=>{})',13,'started\n'],
              ['resolved.mjs','await new Promise(resolve=>setTimeout(resolve,20)); console.log("resolved")',0,'resolved\n'],
              ['import-unresolved.mjs','await import("./unresolved.mjs")',13,'started\n'],
              ['import-resolved.mjs','await import("./resolved.mjs"); console.log("imported")',0,'resolved\nimported\n'],
              ['static-unresolved.mjs','import "./unresolved.mjs"; console.log("unreachable")',13,'started\n'],
              ['requested-exit.mjs','process.exitCode=7; await new Promise(()=>{})',7,''],
              ['requested-zero.mjs','process.exitCode=0; await new Promise(()=>{})',13,''],
              ['requested-thirteen.mjs','process.exitCode=13; await new Promise(()=>{})',13,''],
              ['cached-unresolved.mjs','void import("./unresolved.mjs"); await new Promise(resolve=>setTimeout(resolve,20)); await import("./unresolved.mjs")',13,'started\n'],
              ['floating.cjs','void import("./unresolved.mjs"); console.log("entry")',0,'entry\nstarted\n'],
              ['floating-resolved.cjs','void import("./resolved.mjs"); console.log("entry")',0,'entry\nresolved\n'],
            ]
            if(fileURLs)cases.push(
              ['url-unresolved.mjs','await import(new URL("./unresolved.mjs",import.meta.url).href)',13,'started\n'],
              ['url-resolved.mjs','await import(new URL("./resolved.mjs",import.meta.url).href)',0,'resolved\n'],
            )
            const dev=new NativeDevServer(Object.fromEntries([
              ['/app/index.mjs','export default {fetch(){return new Response("ready")}}'],
              ...cases.map(([name,source])=>['/app/'+name,source]),
            ]),{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
            try{
              await dev.ready
              const results=[]
              for(let repeat=0;repeat<repeats;repeat++)for(const [name,,code,stdout] of cases){
                const controller=new AbortController()
                const timeout=setTimeout(()=>controller.abort(),15000)
                let command
                try{command=await dev.terminalCommand('node '+name,'/app',undefined,controller.signal)}
                finally{clearTimeout(timeout)}
                results.push({name,repeat,code:command.exitCode,stdout:command.stdout,
                  diagnostic:/unsettled top-level await/i.test(command.stderr),expected:{code,stdout}})
              }
              return results
            }finally{await dev.dispose()}
          },{repeats,fileURLs:process.env.NATIVE_TOP_LEVEL_AWAIT_FILE_URL==='1'})
          for(const row of result){
            assert.equal(row.code,row.expected.code,`${browserType.name()} ${JSON.stringify(row)}`)
            assert.equal(row.stdout,row.expected.stdout,`${browserType.name()} ${JSON.stringify(row)}`)
            assert.equal(row.diagnostic,row.code===13&&row.name!=='requested-thirteen.mjs',`${browserType.name()} ${JSON.stringify(row)}`)
          }
          console.log(JSON.stringify({browser:browserType.name(),topLevelAwait:result.length,passed:true}))
          continue
        }
        if(process.env.NATIVE_COMMAND_ALS_REFERENCE==='1'){
          const source=`import {AsyncLocalStorage,AsyncResource,executionAsyncId} from 'node:async_hooks';
            const als=new AsyncLocalStorage();
            const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
            const results=await Promise.all(['a','b','c'].map((id,index)=>als.run(id,async()=>{
              const values=[als.getStore()];
              await delay(3-index);values.push(als.getStore());
              values.push(await Promise.resolve().then(()=>als.getStore()));
              values.push(await als.run(id+'-nested',async()=>{
                await delay(1);return als.getStore();
              }));
              values.push(als.getStore());
              try{await als.run('throw',async()=>{await delay(1);throw Error('expected')})}catch{}
              values.push(als.getStore());
              return values;
            })));
            const lifecycle=new AsyncLocalStorage();
            let bound,snapshot;
            lifecycle.run('captured',()=>{
              bound=AsyncLocalStorage.bind(()=>lifecycle.getStore()??null);
              snapshot=AsyncLocalStorage.snapshot();
            });
            const captured=[bound(),snapshot(()=>lifecycle.getStore()??null)];
            lifecycle.disable();
            const disabled=[bound(),snapshot(()=>lifecycle.getStore()??null)];
            const reused=lifecycle.run('reused',()=>lifecycle.getStore());
            const receiver={value:7};
            const callback=function(argument){return [lifecycle.getStore(),this.value+argument]};
            const boundReceiver=lifecycle.run('receiver',()=>AsyncLocalStorage.bind(callback));
            const receiverResult=boundReceiver.call(receiver,5);
            const resource=lifecycle.run('resource',()=>new AsyncResource('probe'));
            const resourceResult=resource.runInAsyncScope(function(argument){
              return [lifecycle.getStore(),this.value+argument,executionAsyncId()===resource.asyncId()];
            },receiver,5);
            const resourceBound=resource.bind(callback);
            const implicitReceiver=resourceBound.call(receiver,6);
            const explicitReceiver=resource.bind(callback,{value:10}).call(receiver,6);
            console.log(JSON.stringify({results,outside:als.getStore()??null,captured,disabled,reused,
              receiverResult,resourceResult,implicitReceiver,explicitReceiver}));`
          const expected=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'}).trim())
          const result=await page.evaluate(async({source,classic})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({'/app/package.json':'{"type":"module"}',
              '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
              '/app/als.mjs':source},
              {workerURL:window.nativeWorkerURL,workerType:classic?'classic':'module',entry:'index.mjs',serveFetchEntry:true})
            try{await dev.ready;return await dev.terminalCommand('NATIVE_BROWSER_MODULES=1 '+(classic?'NATIVE_CLASSIC_VM=1 ':'')+'node als.mjs')}
            finally{await dev.dispose()}
          },{source,classic:process.env.NATIVE_CLASSIC_VM==='1'})
          assert.equal(result.exitCode,0,JSON.stringify(result))
          const actual=JSON.parse(result.stdout.trim())
          assert.deepEqual(actual,expected)
          console.log('COMMAND_ALS_REFERENCE',JSON.stringify({browser:browserType.name(),actual,expected}))
          continue
        }
        if(process.env.NATIVE_COMMAND_VM_IDENTITY==='1'||process.env.NATIVE_COMMAND_VM_PERSISTENT==='1'||process.env.NATIVE_COMMAND_VM_SOURCE==='1'){
          const persistent=process.env.NATIVE_COMMAND_VM_PERSISTENT==='1'
          const sourceFidelity=process.env.NATIVE_COMMAND_VM_SOURCE==='1'
          const expected=await (sourceFidelity?probeVMFunctionSource:persistent?probeVMPersistentState:probeVMFunctionIdentity)(NativeScript)
          const result=await page.evaluate(async({source,classic})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
              '/app/vm-identity.mjs':source,
            },{workerURL:window.nativeWorkerURL,workerType:classic?'classic':'module',entry:'index.mjs',serveFetchEntry:true})
            try{
              await dev.ready
              return await dev.terminalCommand('NATIVE_BROWSER_MODULES=1 '+(classic?'NATIVE_CLASSIC_VM=1 ':'')+'node vm-identity.mjs')
            }finally{await dev.dispose()}
          },{source:sourceFidelity?vmFunctionSourceSource:persistent?vmPersistentStateSource:vmFunctionIdentitySource,classic:process.env.NATIVE_CLASSIC_VM==='1'})
          assert.equal(result.exitCode,0,JSON.stringify(result))
          assert.equal(result.stderr,'',JSON.stringify(result))
          const actual=JSON.parse(result.stdout.trim())
          console.log(sourceFidelity?'COMMAND_VM_SOURCE':persistent?'COMMAND_VM_PERSISTENT':'COMMAND_VM_IDENTITY',JSON.stringify({browser:browserType.name(),actual,expected}))
          assert.deepEqual(actual,expected)
          continue
        }
        if(process.env.NATIVE_COMMAND_VM_OPTIONS==='1'){
          const source=`import {Script,runInThisContext,runInContext,runInNewContext,createContext} from 'node:vm';
            const records=[];
            const code='globalThis.__vmLimitExecuted=true';
            for(const options of [{timeout:1},{breakOnSigint:true}]){
              for(const run of [
                ()=>new Script(code).runInThisContext(options),
                ()=>new Script(code).runInContext(createContext({}),options),
                ()=>new Script(code).runInNewContext({},options),
                ()=>runInThisContext(code,options),
                ()=>runInContext(code,createContext({}),options),
                ()=>runInNewContext(code,{},options),
              ]){
                try{run();records.push('unexpected execution')}
                catch(error){records.push(error.code)}
              }
            }
            if(globalThis.__vmLimitExecuted)throw Error('Unsupported limit executed code');
            console.log(JSON.stringify(records));`
          const result=await page.evaluate(async source=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
              '/app/vm-options.mjs':source,
            },{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
            try{
              await dev.ready
              return await dev.terminalCommand('NATIVE_BROWSER_MODULES=1 node vm-options.mjs')
            }finally{await dev.dispose()}
          },source)
          assert.equal(result.exitCode,0,JSON.stringify(result))
          assert.equal(result.stderr,'',JSON.stringify(result))
          assert.deepEqual(JSON.parse(result.stdout.trim()),Array(12).fill('ERR_NOT_IMPLEMENTED'))
          console.log('COMMAND_VM_OPTIONS',JSON.stringify({browser:browserType.name(),passed:true}))
          continue
        }
        if(process.env.NATIVE_COMMAND_SOURCE_ERROR==='1'){
          const result=await page.evaluate(async sourceMapTrace=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
              '/app/failure.mjs':'const value=null;\nvalue.owned;',
            },{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
            try{
              await dev.ready
              const {exitCode,stdout,stderr}=await dev.terminalCommand('NATIVE_BROWSER_MODULES=1 '+(sourceMapTrace?'NATIVE_SOURCE_MAP_TRACE=1 ':'')+'node failure.mjs')
              return {exitCode,stdout,stderr}
            }finally{await dev.dispose()}
          },process.env.NATIVE_SOURCE_MAP_TRACE==='1')
          assert.equal(result.exitCode,1,JSON.stringify(result))
          assert.equal(result.stdout,'')
          assert.match(result.stderr,/TypeError/)
          assert.match(result.stderr,/\/app\/failure\.mjs:2:\d+/)
          console.log('COMMAND_SOURCE_ERROR',JSON.stringify({browser:browserType.name(),...result}))
          continue
        }
        if(process.env.NATIVE_NODE_EVAL==='1'){
          const result=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({...files,'/app/index.mjs':'export default {fetch(){return new Response("ready")}}'},
              {workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
            try{
              await dev.ready
              const command=await dev.terminalCommand('node eval-main.js')
              const stdin=await dev.terminalCommand("cat stdin-source.txt | node - 'space value'")
              const esm=await dev.terminalCommand("cat esm-source.txt | node --input-type module - 'esm argument'")
              let result=null
              try{result=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/eval-result.json')))}catch{}
              return {code:command.exitCode,stderr:command.stderr,result,stdin:{code:stdin.exitCode,stderr:stdin.stderr,result:JSON.parse(stdin.stdout)},esm:{code:esm.exitCode,stderr:esm.stderr,result:JSON.parse(esm.stdout)}}
            }finally{await dev.dispose()}
          },nativeNodeEvalFiles)
          assert.deepEqual(result,{code:0,stderr:'',result:{...nativeNodeEvalExpected,esm:nativeNodeEsmExpected,esmFailures:nativeNodeEsmFailuresExpected},stdin:nativeNodeEvalExpected.results.at(-1).stdin,esm:{code:0,...nativeNodeEsmExpected.at(-1)}})
          continue
        }
        if(process.env.NATIVE_HTTP_CLEANUP_CAPACITY==='1'){
          const rows=await page.evaluate(async()=>{
            const {WorkerHTTP}=await import('/native-sdk/index.js')
            const rows=[]
            for(const rejectClose of [false,true]){
              const reason=Error('Write failed'),cancelled=Error('Queued request cancelled')
              const cleanup=[]
              let connections=0,activeClosed=0
              const kernel={connect:async()=>{
                if(++connections>32){let reads=0;return {async read(){return reads++===0?{type:'data',bytes:new TextEncoder().encode('HTTP/1.1 204 Empty\r\n\r\n')}:{type:'end'}},async write(){},async end(){},async close(){activeClosed++}}}
                return {async read(){return null},async write(){throw reason},async end(){},close(){return new Promise((resolve,reject)=>cleanup.push({resolve,reject}))}}
              }}
              const client=new WorkerHTTP(kernel,1234)
              const failures=await Promise.all(Array.from({length:32},()=>client.fetch(new Request('https://preview.invalid/')).catch(error=>error)))
              const controller=new AbortController()
              const queued=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal})).catch(error=>error)
              let completed=false,timer
              const survivor=client.fetch(new Request('https://preview.invalid/')).then(response=>{completed=true;return response.status})
              await new Promise(resolve=>setTimeout(resolve,0))
              const bounded=connections===32&&!completed
              controller.abort(cancelled)
              const queueReason=await queued
              if(rejectClose)cleanup[0].reject(Error('Close failed'));else cleanup[0].resolve()
              try{
                const status=await Promise.race([survivor,new Promise(resolve=>{timer=setTimeout(()=>resolve('Observation deadline'),2000)})])
                rows.push({rejectClose,failures:failures.every(error=>error===reason),bounded,queueReason:queueReason===cancelled,status,connections,activeClosed})
              }finally{clearTimeout(timer);for(const pending of cleanup.slice(1))pending.resolve()}
            }
            return rows
          })
          assert.deepEqual(rows,[false,true].map(rejectClose=>({rejectClose,failures:true,bounded:true,queueReason:true,status:204,connections:33,activeClosed:1})))
          console.log('HTTP_CLEANUP_CAPACITY',JSON.stringify({browser:browserType.name(),rows}))
          continue
        }
        if(process.env.NATIVE_HTTP_REQUEST_HEADER_BYTES==='1'){
          const values=['plain','Cafe\xe9','\xa0value\xa0']
          const rows=await page.evaluate(async values=>{
            const {WorkerHTTP}=await import('/native-sdk/index.js')
            const rows=[]
            for(const value of values){
              let reads=0,sent=''
              const socket={async read(){return reads++===0?{type:'data',bytes:new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')}:{type:'end'}},async write(bytes){sent+=Array.from(bytes,byte=>String.fromCharCode(byte)).join('')},async end(){},async close(){}}
              const response=await new WorkerHTTP({connect:async()=>socket},1234).fetch(new Request('http://localhost/',{headers:{'x-value':value}}))
              await response.text()
              rows.push(/^x-value: (.*)\r$/m.exec(sent)?.[1])
            }
            return rows
          },values)
          assert.deepEqual(rows,values)
          console.log('HTTP_REQUEST_HEADER_BYTES',JSON.stringify({browser:browserType.name(),rows}))
          continue
        }
        if(process.env.NATIVE_HTTP_HEADER_WHITESPACE==='1'){
          const cases=[[' \tplain\t ','plain'],['\xa0value\xa0','\xa0value\xa0'],[' \t\xa0value\xa0\t ','\xa0value\xa0']]
          const rows=await page.evaluate(async cases=>{
            const {WorkerHTTP}=await import('/native-sdk/index.js')
            const rows=[]
            for(const [value] of cases){
              const wire=`HTTP/1.1 200 OK\r\nX-Value:${value}\r\nContent-Length: 0\r\n\r\n`
              let reads=0
              const socket={async read(){return reads++===0?{type:'data',bytes:Uint8Array.from(wire,character=>character.charCodeAt(0))}:{type:'end'}},async write(){},async end(){},async close(){}}
              const response=await new WorkerHTTP({connect:async()=>socket},1234).fetch(new Request('https://preview.invalid/'))
              const clone=response.clone()
              await Promise.all([response.text(),clone.text()])
              rows.push({value:response.headers.get('x-value'),cloneValue:clone.headers.get('x-value')})
            }
            return rows
          },cases)
          assert.deepEqual(rows,cases.map(([,value])=>({value,cloneValue:value})))
          console.log('HTTP_HEADER_WHITESPACE',JSON.stringify({browser:browserType.name(),rows}))
          continue
        }
        if(process.env.NATIVE_HTTP_STATUS_TEXT==='1'){
          const cases=[[200,'Custom result'],[204,'Empty'],[200,'  all done  '],[200,'Cafe\xe9'],[200,'\tspaced\t']]
          const rows=await page.evaluate(async cases=>{
            const {WorkerHTTP}=await import('/native-sdk/index.js')
            const rows=[]
            for(const [status,phrase] of cases){
              const wire=`HTTP/1.1 ${status} ${phrase}\r\nContent-Length: 0\r\n\r\n`
              let reads=0
              const socket={async read(){return reads++===0?{type:'data',bytes:Uint8Array.from(wire,character=>character.charCodeAt(0))}:{type:'end'}},async write(){},async end(){},async close(){}}
              const response=await new WorkerHTTP({connect:async()=>socket},1234).fetch(new Request('https://preview.invalid/'))
              const clone=response.clone()
              await Promise.all([response.text(),clone.text()])
              rows.push({status:response.status,statusText:response.statusText,cloneText:clone.statusText})
            }
            return rows
          },cases)
          assert.deepEqual(rows,cases.map(([status,statusText])=>({status,statusText,cloneText:statusText})))
          console.log('HTTP_STATUS_TEXT',JSON.stringify({browser:browserType.name(),rows}))
          continue
        }
        if(process.env.NATIVE_HTTP_FAILURE_CLOSE==='1'){
          const rows=await page.evaluate(async()=>{
            const {WorkerHTTP}=await import('/native-sdk/index.js')
            const rows=[]
            for(const phase of ['write','headers','body']){
              let reads=0,closed=0,timer
              const reason=Error('Write failed')
              const wire=phase==='body'?'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx':'invalid\r\n\r\n'
              const socket={async read(){return reads++===0?{type:'data',bytes:new TextEncoder().encode(wire)}:{type:'end'}},async write(){if(phase==='write')throw reason},async end(){},close(){closed++;return new Promise(()=>{})}}
              const request=new WorkerHTTP({connect:async()=>socket},1234).fetch(new Request('https://preview.invalid/'))
              const failure=(phase==='body'?request.then(response=>response.text()):request).catch(error=>error)
              try{
                const error=await Promise.race([failure,new Promise(resolve=>{timer=setTimeout(()=>resolve(Error('Observation deadline')),2000)})])
                rows.push({phase,error:String(error),sameReason:phase==='write'?error===reason:null,closed})
              }finally{clearTimeout(timer)}
            }
            return rows
          })
          console.log('HTTP_FAILURE_CLOSE',JSON.stringify({browser:browserType.name(),rows}))
          assert.deepEqual(rows,[{phase:'write',error:'Error: Write failed',sameReason:true,closed:1},{phase:'headers',error:'Error: Invalid HTTP status',sameReason:null,closed:1},{phase:'body',error:'Error: Truncated HTTP body',sameReason:null,closed:1}])
          continue
        }
        if(process.env.NATIVE_HTTP_BODY_REFERENCE==='1'){
          const expected=await probeStreamResponse(Response,runInNewContext('new Uint8Array([1,2,255])'))
          const fixture=await readFile(new URL('./fixtures/native-stream-response.mjs',import.meta.url),'utf8')
          const actual=await page.evaluate(async source=>{
            const {WorkerHTTP}=await import('/native-sdk/index.js')
            let reads=0
            const socket={async read(){return reads++===0?{type:'data',bytes:new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')}:{type:'end'}},async write(){},async end(){},async close(){}}
            const response=await new WorkerHTTP({connect:async()=>socket},1234).fetch(new Request('https://preview.invalid/'))
            const ResponseType=response.constructor
            await response.text()
            const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
            const frame=document.createElement('iframe');document.body.append(frame)
            try{
              const {probeStreamResponse}=await import(url)
              return await probeStreamResponse(ResponseType,new frame.contentWindow.Uint8Array([1,2,255]))
            }finally{frame.remove();URL.revokeObjectURL(url)}
          },fixture)
          assert.deepEqual(actual,expected,`${browserType.name()} actual SDK response bodies`)
          console.log('HTTP_BODY_REFERENCE',JSON.stringify({browser:browserType.name(),actual}))
          continue
        }
        if(process.env.NATIVE_HTTP_RESPONSE_ABORT==='1'){
          const rows=await page.evaluate(async()=>{
            const {WorkerHTTP}=await import('/native-sdk/index.js')
            const rows=[]
            for(const bodyPhase of [false,true]){
              let start,timer,reads=0,closed=0
              const reading=new Promise(resolve=>{start=resolve})
              const socket={read(){
                if(bodyPhase&&reads++===0)return Promise.resolve({type:'data',bytes:new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n')})
                start();return new Promise(()=>{})
              },async write(){},async end(){},close(){closed++;return new Promise(()=>{})}}
              const controller=new AbortController(),reason=Error('Response cancelled')
              const client=new WorkerHTTP({connect:async()=>socket},1234)
              const request=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal}))
              const failure=bodyPhase?(await request).text().catch(error=>error):request.catch(error=>error)
              await reading;controller.abort(reason)
              try{
                const error=await Promise.race([failure,new Promise(resolve=>{timer=setTimeout(()=>resolve(Error('Observation deadline')),2000)})])
                rows.push({bodyPhase,sameReason:error===reason,closed})
              }finally{clearTimeout(timer)}
            }
            return rows
          })
          console.log('HTTP_RESPONSE_ABORT',JSON.stringify({browser:browserType.name(),rows}))
          assert.deepEqual(rows,[false,true].map(bodyPhase=>({bodyPhase,sameReason:true,closed:1})))
          continue
        }
        if(process.env.NATIVE_HTTP_CONNECT_ABORT==='1'){
          const rows=await page.evaluate(async()=>{
            const {WorkerHTTP}=await import('/native-sdk/index.js')
            const rows=[]
            for(const lateReject of [false,true]){
              let start,resolveConnect,rejectConnect,timer,closed=0,writes=0
              const connecting=new Promise(resolve=>{start=resolve})
              const socket={async close(){closed++},async write(){writes++}}
              const client=new WorkerHTTP({connect:()=>{start();return new Promise((resolve,reject)=>{resolveConnect=resolve;rejectConnect=reject})}},1234)
              const controller=new AbortController(),reason=Error('Connection cancelled')
              const failure=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal})).catch(error=>error)
              await connecting;controller.abort(reason)
              try{
                const error=await Promise.race([failure,new Promise(resolve=>{timer=setTimeout(()=>resolve(Error('Observation deadline')),2000)})])
                if(lateReject)rejectConnect(Error('Late connection failure'));else resolveConnect(socket)
                await new Promise(resolve=>setTimeout(resolve,0))
                rows.push({lateReject,sameReason:error===reason,closed,writes})
              }finally{clearTimeout(timer)}
            }
            return rows
          })
          console.log('HTTP_CONNECT_ABORT',JSON.stringify({browser:browserType.name(),rows}))
          assert.deepEqual(rows,[false,true].map(lateReject=>({lateReject,sameReason:true,closed:lateReject?0:1,writes:0})))
          continue
        }
        if(process.env.NATIVE_HTTP_UPLOAD_ABORT==='1'){
          const rows=await page.evaluate(async()=>{
            const {WorkerHTTP}=await import('/native-sdk/index.js')
            const rows=[]
            for(const stalledCancel of [false,true]){
              let start,cancelReason,connections=0,timer
              const reading=new Promise(resolve=>{start=resolve})
              const body=new ReadableStream({pull(){start();return new Promise(()=>{})},cancel(reason){cancelReason=reason;if(stalledCancel)return new Promise(()=>{})}},{highWaterMark:0})
              const controller=new AbortController(),reason=Error('Upload cancelled')
              const request=new Request('https://preview.invalid/',{method:'POST',body,duplex:'half',signal:controller.signal})
              if(request.body!==body){
                void body.cancel(reason).catch(()=>{})
                rows.push({stalledCancel,streamRequestSupported:false,contentType:request.headers.get('content-type')})
                continue
              }
              const client=new WorkerHTTP({connect:async()=>{connections++;throw Error('Unexpected connection')}},1234)
              const failure=client.fetch(request).catch(error=>error)
              try{
                const observed=async()=>{await reading;controller.abort(reason);return await failure}
                const error=await Promise.race([observed(),new Promise(resolve=>{timer=setTimeout(()=>resolve(Error('Observation deadline')),2000)})])
                rows.push({stalledCancel,sameReason:error===reason,sameCancelReason:cancelReason===reason,locked:request.body.locked,connections})
              }finally{clearTimeout(timer)}
            }
            return rows
          })
          console.log('HTTP_UPLOAD_ABORT',JSON.stringify({browser:browserType.name(),rows}))
          const expected=browserType===firefox
            ?[false,true].map(stalledCancel=>({stalledCancel,streamRequestSupported:false,contentType:'text/plain;charset=UTF-8'}))
            :[false,true].map(stalledCancel=>({stalledCancel,sameReason:true,sameCancelReason:true,locked:false,connections:0}))
          assert.deepEqual(rows,expected)
          continue
        }
        if(process.env.NATIVE_SOCKET_SHUTDOWN==='1'){
          const expected=await probeSocketShutdown(nativeNet)
          const result=await page.evaluate(async({source,classic})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
              '/app/socket-shutdown.mjs':source,
            },{workerURL:window.nativeWorkerURL,workerType:classic?'classic':'module',entry:'index.mjs',serveFetchEntry:true,
              env:{NATIVE_BROWSER_MODULES:'1',...(classic?{NATIVE_CLASSIC_VM:'1'}:{})}})
            try{await dev.ready;return await dev.terminalCommand('node socket-shutdown.mjs')}
            finally{await dev.dispose()}
          },{source:socketShutdownSource,classic:process.env.NATIVE_CLASSIC_VM==='1'})
          assert.equal(result.exitCode,0,JSON.stringify(result))
          assert.equal(result.stderr,'',JSON.stringify(result))
          const actual=JSON.parse(result.stdout.trim())
          console.log('SOCKET_SHUTDOWN',JSON.stringify({browser:browserType.name(),actual,expected}))
          assert.deepEqual(actual,expected)
          continue
        }
        if(process.env.NATIVE_CHILD_ABORT==='1'){
          const result=await page.evaluate(async({files,classic,browserModules})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({...files,'/app/index.mjs':'export default {fetch(){return new Response("ready")}}'},
              {workerURL:window.nativeWorkerURL,workerType:classic?'classic':'module',entry:'index.mjs',serveFetchEntry:true,
                env:{...(classic?{NATIVE_CLASSIC_VM:'1'}:{}),...(browserModules?{NATIVE_BROWSER_MODULES:'1'}:{})}})
            try{
              await dev.ready
              const command=await dev.terminalCommand('node abort-main.js')
              let results=null
              try{results=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/abort-result.json')))}catch{}
              return {code:command.exitCode,stderr:command.stderr,results}
            }finally{await dev.dispose()}
          },{files:nativeChildAbortFiles,classic:process.env.NATIVE_CLASSIC_VM==='1',browserModules:process.env.NATIVE_BROWSER_MODULES==='1'})
          assert.deepEqual(result,{code:0,stderr:'',results:nativeChildAbortExpected})
          continue
        }
        if(process.env.NATIVE_EXEC_FILE==='1'){
          const result=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({...files,'/app/index.mjs':'export default {fetch(){return new Response("ready")}}'},
              {workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
            try{
              await dev.ready
              const command=await dev.terminalCommand('node exec-main.js')
              let results=null
              try{results=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/exec-result.json')))}catch{}
              return {code:command.exitCode,stderr:command.stderr,results}
            }finally{await dev.dispose()}
          },nativeExecFileFiles)
          assert.deepEqual(result,{code:0,stderr:'',results:nativeExecFileExpected})
          continue
        }
        if(process.env.NATIVE_CHILD_SPAWN==='1'){
          const result=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({...files,'/app/index.mjs':'export default {fetch(){return new Response("ready")}}'},
              {workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
            try{
              await dev.ready
              const command=await dev.terminalCommand('node spawn-main.js')
              return {code:command.exitCode,stderr:command.stderr,
                result:JSON.parse(new TextDecoder().decode(await dev.readFile('/app/spawn-result.json'))),
                ended:new TextDecoder().decode(await dev.readFile('/app/spawn-child-ended'))}
            }finally{await dev.dispose()}
          },nativeSpawnFiles)
          assert.deepEqual(result,{code:0,stderr:'',result:{spawned:true,code:0,signal:null,
            stdout:[255,0,240,159,152,128],stderr:'child warning\n',connected:false,closedAfterOutputEnd:true,
            unread:{code:0,signal:null,stdoutEnded:true,stderrEnded:true}},ended:'yes'})
          continue
        }
        if(process.env.NATIVE_STDIN_LIFECYCLE==='1'){
          const result=await page.evaluate(async sources=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const files={'/app/package.json':'{"type":"module"}'}
            for(const [name,source] of Object.entries(sources))files['/app/'+name+'.js']=source
            files['/app/main.mjs']=`import {Worker} from 'node:worker_threads';import {writeFileSync} from 'node:fs';
for(const name of ${JSON.stringify(Object.keys(sources))}){
 const child=new Worker('/app/'+name+'.js',{command:true});let stdout='',stderr='',sent=false;
 child.on('stdout-bytes',(bytes,done)=>{stdout+=new TextDecoder().decode(bytes);done?.();
  if(name==='resumed'&&!sent&&stdout.includes('ready\\n')){sent=true;void child.writeInput(new TextEncoder().encode('payload')).then(()=>child.writeInput(null))}
 });
 child.on('stderr-bytes',(bytes,done)=>{stderr+=new TextDecoder().decode(bytes);done?.()});
 child.on('error',error=>writeFileSync('/app/'+name+'-error.txt',String(error)));
 child.on('exit',code=>writeFileSync('/app/'+name+'-result.json',JSON.stringify({name,code,stdout,stderr})));
}`
            const dev=new NativeDevServer(files,{workerURL:window.nativeWorkerURL,entry:'main.mjs'})
            try{
              await dev.ready
              for(let attempt=0;attempt<100;attempt++){
                const results=[]
                for(const name of Object.keys(sources)){
                  try{results.push(JSON.parse(new TextDecoder().decode(await dev.readFile('/app/'+name+'-result.json'))))}catch{}
                }
                if(results.length===Object.keys(sources).length)return {results}
                if(attempt===99)return {results,missing:Object.keys(sources).filter(name=>!results.some(result=>result.name===name))}
                await new Promise(resolve=>setTimeout(resolve,100))
              }
            }finally{await dev.dispose()}
          },stdinLifecycleSources)
          assert.deepEqual(result,{results:Object.keys(stdinLifecycleSources).map(name=>({name,code:0,
            stdout:name==='resumed'?'ready\npayload':'ready\n',stderr:''}))})
          continue
        }
        if(process.env.NATIVE_STDIN_LIFETIME==='1'){
          const result=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer(files,{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
            try{
              await dev.ready
              const results=[]
              for(const mode of ['data','readable']){
                const command=await dev.terminalCommand('set -o pipefail; node delayed-input-producer.js '+mode+' | node listener-input.js '+mode+' > lifetime-'+mode+'.bin')
                let ended=null
                try{ended=new TextDecoder().decode(await dev.readFile('/app/input-listener-ended-'+mode))}catch{}
                results.push({code:command.exitCode,stderr:command.stderr,bytes:[...await dev.readFile('/app/lifetime-'+mode+'.bin')],ended})
              }
              return results
            }finally{await dev.dispose()}
          },nativeBinaryShellFiles)
          assert.deepEqual(result,Array.from({length:2},()=>({code:0,stderr:'',bytes:[255,0,240,159,152,128],ended:'6'})))
          continue
        }
        if(process.env.NATIVE_TERMINAL_BINARY==='1'){
          const binary=await page.evaluate(async files=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer(files,{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
            try{
              await dev.ready
              const pipeline=await dev.terminalCommand('node output-probe.js | cat > pipeline.bin')
              const direct=await dev.terminalCommand('node output-probe.js > direct.bin')
              const stderr=await dev.terminalCommand('node error-probe.js 2> error.bin')
              const burst=await dev.terminalCommand('set -o pipefail; node burst-probe.js | cat > burst.bin')
              const worker=await dev.terminalCommand('set -o pipefail; node worker-burst.js | cat > worker.bin')
              const fork=await dev.terminalCommand('set -o pipefail; node fork-burst.js | cat > fork.bin')
              const stdin=await dev.terminalCommand('set -o pipefail; node burst-probe.js | node slow-input.js > stdin.bin')
              const stdinMetrics=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/stdin-result.json')))
              const forkInput=await dev.terminalCommand('set -o pipefail; node burst-probe.js | node fork-input.js > fork-input.bin')
              const forkInputMetrics=JSON.parse(new TextDecoder().decode(await dev.readFile('/app/stdin-result.json')))
              const bursts=await Promise.all(['burst.bin','worker.bin','fork.bin','stdin.bin','fork-input.bin'].map(async name=>{
                const bytes=await dev.readFile('/app/'+name)
                let mismatches=0
                for(let i=0;i<bytes.length;i++)if(bytes[i]!==i%65536%251)mismatches++
                return {length:bytes.length,mismatches}
              }))
              return {codes:[pipeline.exitCode,direct.exitCode,stderr.exitCode,burst.exitCode,worker.exitCode,fork.exitCode,stdin.exitCode,forkInput.exitCode],
                bursts,stdinMetrics,forkInputMetrics,
                files:await Promise.all(['pipeline.bin','direct.bin','error.bin'].map(async name=>[...await dev.readFile('/app/'+name)]))}
            }finally{await dev.dispose()}
          },nativeBinaryShellFiles)
          for(const metrics of [binary.stdinMetrics,binary.forkInputMetrics]){
            assert.equal(metrics.received,4*1024*1024)
            assert.equal(metrics.mismatches,0)
            assert.ok(Number.isInteger(metrics.maxBuffered)&&metrics.maxBuffered>=0&&metrics.maxBuffered<=131072,
              `${browserType.name()} slow stdin exceeded two transport chunks: ${JSON.stringify(metrics)}`)
          }
          assert.deepEqual({...binary,stdinMetrics:undefined,forkInputMetrics:undefined},
            {codes:[0,0,0,0,0,0,0,0],bursts:Array.from({length:5},()=>({length:4*1024*1024,mismatches:0})),
              stdinMetrics:undefined,forkInputMetrics:undefined,files:Array.from({length:3},()=>[255,0,240,159,152,128])})
          continue
        }
        if(process.env.NATIVE_THREAD_COMMAND==='1'){
          const command=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/main.mjs':`import {Worker} from 'node:worker_threads';import {writeFileSync} from 'node:fs';
                const child=new Worker('/app/command.mjs',{command:true,argv:['hello'],cwd:'/app'});
                let stdout='',stderr='';
                const stdoutDecoder=new TextDecoder(),stderrDecoder=new TextDecoder();
                child.on('stdout-bytes',(bytes,done)=>{stdout+=stdoutDecoder.decode(bytes,{stream:true});done?.()});
                child.on('stderr-bytes',(bytes,done)=>{stderr+=stderrDecoder.decode(bytes,{stream:true});done?.()});
                child.on('online',async()=>{await child.writeInput(new TextEncoder().encode('from stdin'));await child.writeInput(null)});
                child.on('error',error=>writeFileSync('/app/error.txt',String(error)));
                child.on('exit',code=>writeFileSync('/app/result.json',JSON.stringify({code,stdout,stderr})));`,
              '/app/command.mjs':`import {writeFileSync} from 'node:fs';
                console.log('hello',process.argv[2]);
                process.stderr.write('warning\\n');
                process.stdin.on('data',chunk=>process.stdout.write('input:'+chunk.toString()+'\\n'));
                await new Promise(resolve=>setTimeout(resolve,30));
                writeFileSync('/app/command-output.txt','finished');`,
            },{workerURL:window.nativeWorkerURL,entry:'main.mjs'})
            try{
              await dev.ready
              for(let attempt=0;attempt<150;attempt++){
                try{return {result:JSON.parse(new TextDecoder().decode(await dev.readFile('/app/result.json'))),
                  file:new TextDecoder().decode(await dev.readFile('/app/command-output.txt'))}}
                catch{await new Promise(resolve=>setTimeout(resolve,100))}
              }
              return {timeout:true,diagnostics:dev.diagnostics,progress:dev.progress}
            }finally{await dev.dispose()}
          })
          assert.deepEqual(command,{result:{code:0,stdout:'hello hello\ninput:from stdin\n',stderr:'warning\n'},file:'finished'},
            `${browserType.name()} isolated command: ${JSON.stringify(command)}`)
          continue
        }
        if(process.env.NATIVE_TERMINAL_VITEST==='1'){
          // A guest abort cannot recover a blocked browser process. Keep the
          // opt-in compiler experiment bounded by its host-owned browser too.
          const browserDeadline=process.env.NATIVE_BROWSER_MODULES==='1'?setTimeout(()=>{
            console.error('BROWSER_MODULE_PROBE_DEADLINE',browserType.name())
            void browser.close()
          },45000):undefined
          const runner=await page.evaluate(async({forkOnly,rpcOnly,rpcParent,rpcChild,portChild,vitestPool,rpcTrace,vitestOnly,featureSource,outputWorkerSource,browserModules,stackLocationTrace,commandActivityTrace,classicVM})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const manifest=await(await fetch('/fixtures/install-vitest/package.json')).text()
            const lock=await(await fetch('/fixtures/install-vitest/package-lock.json')).text()
            const dev=new NativeDevServer({
              '/app/package.json':manifest,'/app/package-lock.json':lock,
              '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
              '/app/answer.test.js':'import {test,expect} from "vitest";test("adds",()=>expect(2+3).toBe(5));',
              ...(featureSource?{'/app/features.test.js':featureSource,'/app/feature-value.js':'export const answer=-1','/app/output-probe.js':outputWorkerSource}:{}),
              '/app/native-birpc-parent.mjs':rpcParent,
              '/app/native-birpc-child.mjs':rpcChild,
              '/app/native-worker-port-child.mjs':portChild,
              '/app/fork-probe.mjs':'import {mode} from "launch-probe";process.on("message",message=>{console.log("child output",mode);process.send({answer:message.value+3});process.exit(7)});process.send({ready:true});',
              '/app/node_modules/launch-probe/package.json':'{"name":"launch-probe","type":"module","exports":{"development":"./development.js","default":"./fallback.js"}}',
              '/app/node_modules/launch-probe/development.js':'export const mode="development"',
              '/app/node_modules/launch-probe/fallback.js':'export const mode="fallback"',
            },{workerURL:window.nativeWorkerURL,workerType:classicVM?'classic':'module',entry:'index.mjs',serveFetchEntry:true,installCommand:'npm install --ignore-scripts'})
            try{
              console.log('VITEST_COMMAND_STAGE '+JSON.stringify({stage:'install-start'}))
              await dev.ready
              console.log('VITEST_COMMAND_STAGE '+JSON.stringify({stage:'install-complete'}))
              if(!vitestOnly){
              const forkSource='const {MessageChannel}=require("node:worker_threads");const channel=new MessageChannel();channel.port1.on("message",value=>{console.log("port answer",value);channel.port1.close();channel.port2.close()});channel.port2.postMessage(42);const {fork}=require("node:child_process");const child=fork("/app/fork-probe.mjs",[],{silent:true,serialization:"advanced",execArgv:["--conditions","development"]});child.stdout.on("data",bytes=>process.stdout.write(bytes));child.on("message",message=>{if(message.ready)child.send({value:2});else console.log("answer",message.answer)});child.on("exit",code=>console.log("child exit",code));'
              const forkProbe=await dev.terminalCommand(`node -e '${forkSource}'`)
              if(forkProbe.exitCode!==0||!forkProbe.stdout.includes('port answer 42')||!forkProbe.stdout.includes('answer 5')||!forkProbe.stdout.includes('child output development')||!forkProbe.stdout.includes('child exit 7'))
                throw Error(`Fork probe failed: ${JSON.stringify(forkProbe)}`)
              console.log('FORK_PROBE_PASSED',forkProbe.stdout)
              if(forkOnly)return {fork:{exitCode:forkProbe.exitCode,stdout:forkProbe.stdout,stderr:forkProbe.stderr}}
              const rpcProbe=await dev.terminalCommand('node native-birpc-parent.mjs'+(rpcTrace?' --trace-modules':''))
              if(rpcProbe.exitCode!==0||rpcProbe.stdout!=='rpc answer:5\nrpc exit:0\n'||rpcProbe.stderr)
                throw Error('Bundled RPC probe failed: '+JSON.stringify(rpcProbe))
              if(rpcOnly)return {rpc:{exitCode:rpcProbe.exitCode,stdout:rpcProbe.stdout,stderr:rpcProbe.stderr}}
              }
              console.log('VITEST_COMMAND_STAGE '+JSON.stringify({stage:'version-start'}))
              const version=await dev.terminalCommand('vitest --version')
              console.log('VITEST_COMMAND_STAGE '+JSON.stringify({stage:'version-complete',exitCode:version.exitCode}))
              const controller=new AbortController()
              let pendingProgress=[]
              let pendingModules=[]
              const timer=setTimeout(()=>{
                pendingProgress=dev.progress.filter(item=>!item.phase.includes('module-fetch-')).slice(-60)
                pendingModules=dev.progress.filter(item=>item.phase.includes('module-fetch-')).slice(-20)
                controller.abort()
              },30000)
              let run
              console.log('VITEST_COMMAND_STAGE '+JSON.stringify({stage:'positive-start'}))
              try{run=await dev.terminalCommand((browserModules?'NATIVE_BROWSER_MODULES=1 ':'')+(classicVM?'NATIVE_CLASSIC_VM=1 ':'')+(commandActivityTrace?'NATIVE_COMMAND_ACTIVITY_TRACE=1 ':'')+'NATIVE_IPC_TRACE=1 NATIVE_MODULE_TRACE=1 vitest run'+(vitestPool==='threads'?' --pool=threads':''),'/app',undefined,controller.signal)}
              finally{clearTimeout(timer)}
              console.log('VITEST_COMMAND_STAGE '+JSON.stringify({stage:'positive-complete',exitCode:run.exitCode,stdout:run.stdout,stderr:run.stderr}))
              const runProgress=dev.progress.filter(item=>!item.phase.includes('module-fetch-')).slice(-60)
              const summary=({exitCode,stdout,stderr,changedPaths})=>({exitCode,stdout,stderr,changedPaths})
              let negative
              if(featureSource&&(run.exitCode===0||run.exitCode===1)){
                await dev.writeFile('/app/expected-failure.test.js',stackLocationTrace
                  ?'import {test,expect} from "vitest";test("expected failure",()=>{try{expect(1).toBe(2)}catch(error){console.error("RAW_ASSERTION_STACK",error.stack);throw error}})'
                  :'import {test,expect} from "vitest";test("expected failure",()=>expect(1).toBe(2))')
                console.log('VITEST_COMMAND_STAGE '+JSON.stringify({stage:'negative-start'}))
                negative=await dev.terminalCommand((browserModules?'NATIVE_BROWSER_MODULES=1 ':'')+(classicVM?'NATIVE_CLASSIC_VM=1 ':'')+(stackLocationTrace?'NATIVE_VM_SOURCE_TRACE=/app/expected-failure.test.js ':'')+'vitest run expected-failure.test.js'+(vitestPool==='threads'?' --pool=threads':''))
                console.log('VITEST_COMMAND_STAGE '+JSON.stringify({stage:'negative-complete',exitCode:negative.exitCode}))
              }
              return {version:summary(version),run:summary(run),negative:negative&&summary(negative),runProgress,diagnostics:dev.diagnostics,pendingProgress,pendingModules,progress:dev.progress.slice(-10)}
            }catch(error){return {error:String(error),diagnostics:dev.diagnostics,progress:dev.progress.slice(rpcTrace?-60:-10)}}
            finally{await dev.dispose()}
          },{forkOnly:process.env.NATIVE_TERMINAL_FORK_ONLY==='1',rpcOnly:process.env.NATIVE_TERMINAL_RPC_ONLY==='1',vitestPool:process.env.NATIVE_VITEST_POOL,rpcTrace:process.env.NATIVE_RPC_TRACE==='1',
            vitestOnly:process.env.NATIVE_VITEST_COMMAND_ONLY==='1',
            browserModules:process.env.NATIVE_BROWSER_MODULES==='1',
            classicVM:process.env.NATIVE_CLASSIC_VM==='1',
            stackLocationTrace:process.env.NATIVE_STACK_LOCATION_TRACE==='1',
            commandActivityTrace:process.env.NATIVE_COMMAND_ACTIVITY_TRACE==='1',
            featureSource:process.env.NATIVE_VITEST_BREADTH==='1'?await readFile('tests/fixtures/native-vitest-features.mjs','utf8'):undefined,
            outputWorkerSource:await readFile('tests/fixtures/native-output-worker.mjs','utf8'),
            rpcParent:await readFile('tests/fixtures/native-birpc-parent.mjs','utf8'),
            portChild:await readFile('tests/fixtures/native-worker-port-child.mjs','utf8'),
            rpcChild:await readFile('tests/fixtures/native-birpc-child.mjs','utf8')})
          if(browserDeadline)clearTimeout(browserDeadline)
          console.log('VITEST_CLI_RESULT',browserType.name(),JSON.stringify(runner))
          if(runner.pendingProgress)console.log('VITEST_RPC_TRACE',JSON.stringify(runner.pendingProgress.filter(item=>/ipc-|v8-|rpc-request|rpc-response/.test(item.phase))))
          if(process.env.NATIVE_TERMINAL_RPC_ONLY==='1'){
            assert.equal(runner.rpc?.exitCode,0,JSON.stringify(runner))
            continue
          }
          if(process.env.NATIVE_TERMINAL_FORK_ONLY==='1'){
            assert.equal(runner.fork?.exitCode,0,JSON.stringify(runner))
            continue
          }
          assert.equal(runner.version?.exitCode,0,JSON.stringify(runner))
          assert.equal(runner.run?.exitCode,0,JSON.stringify(runner))
          assert.match(runner.run.stdout,process.env.NATIVE_VITEST_BREADTH==='1'?/17 passed/:/1 passed/)
          assert.doesNotMatch(runner.run.stderr,/Timeout terminating|Failed to terminate|Unhandled Error/,JSON.stringify(runner))
          if(process.env.NATIVE_VITEST_BREADTH==='1'){
            assert.match(runner.run.stdout,/17 passed/)
            assert.equal(runner.negative?.exitCode,1,JSON.stringify(runner))
            assert.match(runner.negative.stdout,/1 failed/)
            if(process.env.NATIVE_BROWSER_MODULES==='1'){
              assert.match(stripVTControlCharacters(runner.negative.stderr),/expected-failure\.test\.js:1:[1-9]\d*/,
                `${browserType.name()} must report the original assertion source location`)
              if(process.env.NATIVE_STACK_LOCATION_TRACE!=='1'){
                const location=stripVTControlCharacters(runner.negative.stderr).match(/expected-failure\.test\.js:1:(\d+)/)
                const source='import {test,expect} from "vitest";test("expected failure",()=>expect(1).toBe(2))'
                assert.ok(Number(location?.[1])<=source.length,
                  `${browserType.name()} assertion column must belong to the original source line`)
              }
            }
            assert.doesNotMatch(runner.negative.stderr,/Timeout terminating|Failed to terminate|Unhandled Error/,JSON.stringify(runner))
          }
          continue
        }
        if(process.env.NATIVE_TERMINAL_BIN==='1'){
          const binRun=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':JSON.stringify({name:'bin-test',version:'1.0.0',type:'module',
                scripts:{hello:'prettier --version',format:'prettier --write example.js',
                  check:'prettier --check example.js',stdin:'prettier --stdin-filepath example.js'},dependencies:{prettier:'3.9.9'}}),
              '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
              '/app/example.js':'const answer=42',
            },{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true,installCommand:'npm install --ignore-scripts'})
            try{
              await dev.ready
              await dev.writeFile('/app/exit.mjs','console.log("before exit");process.exit(7);console.log("after exit")')
              const exited=await dev.terminalCommand('node exit.mjs')
              const result=await dev.terminalCommand('npm run hello')
              const unchecked=await dev.terminalCommand('npm run check')
              const formatted=await dev.terminalCommand('npm run format')
              const checked=await dev.terminalCommand('npm run check')
              await dev.writeFile('/app/formatter-import.mjs','import {format as indexFormat} from "/app/node_modules/prettier/index.mjs";import {format as standaloneFormat} from "/app/node_modules/prettier/standalone.mjs";import typescript from "prettier/plugins/typescript";import estree from "prettier/plugins/estree";let rejected=false;try{await standaloneFormat("const value=43",{parser:"typescript"})}catch{rejected=true}if(!rejected)throw Error("Standalone must require explicit parser plugins");process.stdout.write(await indexFormat("const value=42",{parser:"typescript"}));process.stdout.write(await standaloneFormat("const value=43",{parser:"typescript",plugins:[typescript,estree]}))')
              const imported=await dev.terminalCommand('node formatter-import.mjs')
              const channel=new MessageChannel()
              const inputRun=dev.terminalCommand('npm run stdin','/app',undefined,undefined,channel.port2)
              channel.port1.postMessage({type:'data',bytes:new TextEncoder().encode('const value=43')})
              channel.port1.postMessage({type:'end'})
              const stdin=await inputRun.finally(()=>channel.port1.close())
              const file=new TextDecoder().decode(await dev.readFile('/app/example.js'))
              return {result,exited,unchecked,formatted,checked,stdin,file,imported}
            }catch(error){return {error:String(error),diagnostics:dev.diagnostics,progress:dev.progress}}
            finally{await dev.dispose()}
          })
          assert.equal(binRun.exited?.exitCode,7,JSON.stringify(binRun))
          assert.match(binRun.exited.stdout,/before exit/)
          assert.doesNotMatch(binRun.exited.stdout,/after exit/)
          assert.equal(binRun.result?.exitCode,0,JSON.stringify(binRun))
          assert.match(binRun.result.stdout,/3\.9\.9/)
          assert.equal(binRun.formatted?.exitCode,0,JSON.stringify(binRun))
          assert.equal(binRun.unchecked?.exitCode,1,JSON.stringify(binRun))
          assert.equal(binRun.checked?.exitCode,0,JSON.stringify(binRun))
          assert.equal(binRun.imported?.exitCode,0,JSON.stringify(binRun))
          assert.equal(binRun.imported.stdout,'const value = 42;\nconst value = 43;\n')
          assert.equal(binRun.stdin?.exitCode,0,JSON.stringify(binRun))
          assert.match(binRun.stdin.stdout,/const value = 43;/)
          assert.equal(binRun.file,'const answer = 42;\n')
          continue
        }
        if(process.env.NATIVE_TERMINAL_PACKAGE==='1'){
          const packageRun=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':JSON.stringify({type:'module',scripts:{
                task:'node task.mjs && printf done',
                pretask:'printf pre-task',posttask:'printf post-task',
                preblocked:'exit 7',blocked:'printf should-not-run',postblocked:'printf should-not-run',
                prelifecycle:'node lifecycle.mjs',lifecycle:'node lifecycle.mjs',postlifecycle:'node lifecycle.mjs',
                nested:'npm run task',
                args:'node task.mjs',
                parallel:'npm run args | npm run args',
                cycle:'npm run cycle',
                input:'node input.mjs',
                long:'node long.mjs',
                unsupported:'missing-command',
              }}),
              '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
              '/app/lifecycle.mjs':"console.log('HOOK_ENV '+JSON.stringify({event:process.env.npm_lifecycle_event,script:process.env.npm_lifecycle_script,args:process.argv.slice(2)}));",
              '/app/task.mjs':"import {writeFileSync} from 'node:fs';console.log('lifecycle:'+process.env.npm_lifecycle_event);console.log('arg:'+process.argv[2]);writeFileSync('/app/result.txt','written');",
              '/app/input.mjs':"process.stdin.on('data',chunk=>process.stdout.write('input:'+chunk.toString()));",
              '/app/long.mjs':"import {writeFileSync} from 'node:fs';console.log('started');await new Promise(resolve=>setTimeout(resolve,10000));writeFileSync('/app/late.txt','late');",
              '/app/sub/package.json':JSON.stringify({type:'module',scripts:{sub:'node sub.mjs'}}),
              '/app/sub/sub.mjs':"console.log('subdir:'+process.cwd());",
            },{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true,installDependencies:false})
            try{
              await dev.ready
              const task=await dev.terminalCommand('npm run task')
              const blocked=await dev.terminalCommand('npm run blocked')
              const lifecycle=await dev.terminalCommand('npm run lifecycle -- "forwarded value"')
              const nested=await dev.terminalCommand('pnpm run nested')
              const argument=await dev.terminalCommand('npm run args -- "hello world"')
              const subdir=await dev.terminalCommand('npm run sub','/app/sub')
              const parallel=await dev.terminalCommand('npm run parallel')
              const cycle=await dev.terminalCommand('npm run cycle')
              const channel=new MessageChannel()
              const inputResult=dev.terminalCommand('npm run input','/app',undefined,undefined,channel.port2)
              channel.port1.postMessage({type:'data',bytes:new TextEncoder().encode('hello')})
              channel.port1.postMessage({type:'end'})
              const input=await inputResult
              channel.port1.close()
              const unsupported=await dev.terminalCommand('npm run unsupported')
              const controller=new AbortController()
              let announceOutput
              const output=new Promise(resolve=>{announceOutput=resolve})
              const long=dev.terminalCommand('npm run long','/app',text=>{
                if(text.includes('started'))announceOutput()
              },controller.signal)
              await Promise.race([output,new Promise((_,reject)=>setTimeout(()=>reject(Error('No early package output')),15000))])
              controller.abort()
              const interrupted=await long
              let lateFile=false
              try{await dev.readFile('/app/late.txt');lateFile=true}catch{}
              const after=await dev.terminalCommand('pwd')
              return {task,blocked,lifecycle,nested,argument,subdir,parallel,cycle,input,unsupported,interrupted,lateFile,after,
                file:new TextDecoder().decode(await dev.readFile('/app/result.txt'))}
            }catch(error){return {error:String(error),diagnostics:dev.diagnostics}}
            finally{await dev.dispose()}
          })
          assert.equal(packageRun.task?.exitCode,0,JSON.stringify(packageRun))
          assert.match(packageRun.task.stdout,/lifecycle:task/)
          assert.match(packageRun.task.stdout,/done/)
          assert.ok(packageRun.task.stdout.indexOf('pre-task')<packageRun.task.stdout.indexOf('lifecycle:task'))
          assert.ok(packageRun.task.stdout.lastIndexOf('post-task')>packageRun.task.stdout.indexOf('lifecycle:task'))
          assert.equal(packageRun.blocked?.exitCode,7,JSON.stringify(packageRun))
          assert.doesNotMatch(packageRun.blocked.stdout,/should-not-run/)
          assert.equal(packageRun.lifecycle?.exitCode,0,JSON.stringify(packageRun))
          const hooks=[...packageRun.lifecycle.stdout.matchAll(/HOOK_ENV (\{[^\n]+\})/g)].map(match=>JSON.parse(match[1]))
          assert.deepEqual(hooks,[
            {event:'prelifecycle',script:'node lifecycle.mjs',args:[]},
            {event:'lifecycle',script:'node lifecycle.mjs',args:['forwarded value']},
            {event:'postlifecycle',script:'node lifecycle.mjs',args:[]},
          ])
          assert.ok(packageRun.task.changedPaths.includes('/app/result.txt'))
          assert.equal(packageRun.nested?.exitCode,0,JSON.stringify(packageRun))
          assert.match(packageRun.nested.stdout,/lifecycle:task/)
          assert.equal(packageRun.argument?.exitCode,0,JSON.stringify(packageRun))
          assert.match(packageRun.argument.stdout,/arg:hello world/)
          assert.equal(packageRun.subdir?.exitCode,0,JSON.stringify(packageRun))
          assert.match(packageRun.subdir.stdout,/subdir:\/app\/sub/)
          assert.equal(packageRun.parallel?.exitCode,0,JSON.stringify(packageRun))
          assert.equal(packageRun.cycle?.exitCode,1,JSON.stringify(packageRun))
          assert.match(packageRun.cycle.stderr,/Project script cycle/)
          assert.equal(packageRun.input?.exitCode,0,JSON.stringify(packageRun))
          assert.match(packageRun.input.stdout,/input:hello/)
          assert.equal(packageRun.unsupported?.exitCode,127,JSON.stringify(packageRun))
          assert.match(packageRun.unsupported.stderr,/command not found/)
          assert.equal(packageRun.interrupted?.exitCode,130,JSON.stringify(packageRun))
          assert.equal(packageRun.lateFile,false,JSON.stringify(packageRun))
          assert.equal(packageRun.after?.stdout,'/project\n',JSON.stringify(packageRun))
          assert.equal(packageRun.file,'written')
          continue
        }
        if(process.env.NATIVE_TERMINAL_NODE==='1'){
          const command=await page.evaluate(async({classic,browserModules})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/index.mjs':'import {symlinkSync} from "node:fs";symlinkSync("index.mjs","/app/path-probe-link");export default {fetch(){return new Response("ready")}}',
              '/app/command.mjs':`import {writeFileSync} from 'node:fs';
                console.log('hello',process.argv[2]);
                process.stderr.write('warning\\n');
                process.stdin.on('data',chunk=>process.stdout.write('input:'+chunk.toString()+'\\n'));
                await new Promise(resolve=>setTimeout(resolve,30));
                writeFileSync('/app/command-output.txt','finished');`,
              '/app/long.mjs':`import {writeFileSync} from 'node:fs';
                console.log('started');
                await new Promise(resolve=>setTimeout(resolve,10000));
                writeFileSync('/app/should-not-exist.txt','late');`,
              '/app/async-cli.cjs':`module.exports.__promise=new Promise(resolve=>setTimeout(resolve,30))
                .then(()=>{console.log('async command complete')})`,
              '/app/dynamic-entry.mjs':`import('./dynamic-child.mjs')`,
              '/app/dynamic-child.mjs':`console.log('dynamic import complete')`,
              '/app/pipeline-probe.mjs':`import {Writable} from 'node:stream';import {pipeline,finished} from 'node:stream/promises';
                for(const useError of [true,false]){
                  const destination=new Writable({write(chunk,encoding,done){done()}});
                  destination.on('error',()=>{});
                  let cancelled=false;
                  const source=new ReadableStream({cancel(){cancelled=true}});
                  const running=pipeline(source,destination);
                  destination.destroy(useError?Error('pipeline probe failure'):undefined);
                  let timeout;try{
                    await Promise.race([running,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('pipeline stalled')),1000)})]);
                    throw Error('Pipeline accepted failed destination');
                  }catch(error){
                    if(useError?!String(error).includes('pipeline probe failure'):error.code!=='ERR_STREAM_PREMATURE_CLOSE')throw error;
                    if(!cancelled||source.locked)throw Error('Reader was not released');
                  }finally{clearTimeout(timeout)}
                }
                const controller=new AbortController(),destination=new Writable({write(chunk,encoding,done){done()}});
                let cancelled=false;const source=new ReadableStream({cancel(){cancelled=true}});
                const aborted=pipeline(source,destination,{signal:controller.signal});controller.abort();
                try{await aborted;throw Error('Abort accepted')}catch(error){if(error.code!=='ABORT_ERR')throw error}
                if(!cancelled||source.locked||!destination.destroyed)throw Error('Abort cleanup incomplete');
                const observed=new Writable({write(chunk,encoding,done){done()}}),observerController=new AbortController();
                const observation=finished(observed,{signal:observerController.signal,cleanup:true});observerController.abort();
                try{await observation;throw Error('Finished abort accepted')}catch(error){if(error.code!=='ABORT_ERR')throw error}
                if(observed.destroyed||observed.listenerCount('error')||observed.listenerCount('close'))throw Error('Finished abort cleanup incomplete');
                observed.end();
                const completed=new Writable({write(chunk,encoding,done){done()}});
                const completion=finished(completed,{cleanup:true});completed.end();await completion;
                if(completed.listenerCount('error')||completed.listenerCount('close'))throw Error('Finished completion cleanup incomplete');
                console.log('pipeline failures passed');`,
              '/app/chained-timers.mjs':`setTimeout(()=>Promise.resolve().then(()=>Promise.resolve()).then(()=>{
                setTimeout(()=>console.log('chained timers finished'),15)
              }),5);`,
              '/app/worker-owner.mjs':`import {Worker} from 'node:worker_threads';
                const child=new Worker('/app/worker-owner-child.mjs');
                child.on('error',error=>{console.error(error);process.exitCode=1});
                child.on('message',value=>console.log(value));
                child.on('exit',code=>console.log('worker exit:'+code));`,
              '/app/worker-owner-child.mjs':`import {parentPort} from 'node:worker_threads';
                setTimeout(()=>parentPort.postMessage('worker completed'),30);`,
              '/app/worker-terminate.mjs':`import {Worker} from 'node:worker_threads';
                const early=new Worker('/app/worker-terminate-child.mjs');
                if(await early.terminate()!==0||await early.terminate()!==undefined)throw Error('Early termination result mismatch');
                const running=new Worker('/app/worker-terminate-child.mjs'),exits=[];
                running.on('exit',code=>exits.push(code));
                await new Promise((resolve,reject)=>{running.once('online',resolve);running.once('error',reject)});
                const first=running.terminate(),second=running.terminate();
                if(exits.length)throw Error('Termination exit was synchronous');
                if(await first!==1||await second!==1||exits.length!==1||exits[0]!==1)throw Error('Termination result mismatch');
                if(await running.terminate()!==undefined)throw Error('Exited worker invented another result');
                const bytes=new Uint8Array([1,2]);running.postMessage({bytes},[bytes.buffer]);running.postMessage(()=>{});
                if(bytes.byteLength!==2)throw Error('Exited worker detached transfer');
                console.log('worker termination passed');`,
              '/app/worker-terminate-child.mjs':`setInterval(()=>{},1000);`,
              '/app/port-ref-probe.mjs':`import {MessageChannel} from 'node:worker_threads';
                const {port1,port2}=new MessageChannel();const callback=()=>{};
                if(port1.hasRef())throw Error('Fresh port is referenced');
                port1.on('close',callback);if(port1.hasRef())throw Error('Close listener referenced port');
                port1.on('message',callback);if(!port1.hasRef())throw Error('Message listener did not reference port');
                port1.unref();port1.on('message',()=>{});if(port1.hasRef())throw Error('Additional listener overrode unref');
                port1.removeAllListeners();
                await new Promise((resolve,reject)=>{
                  port1.once('message',()=>{if(port1.hasRef())reject(Error('Once listener retained reference'));else resolve()});
                  if(!port1.hasRef())reject(Error('Reused port was not referenced'));
                  port2.postMessage(42);
                });let closed=0;port1.on('close',()=>closed++);
                port1.close();port1.close();port2.close();
                if(closed!==0)throw Error('Close notification was synchronous');
                await Promise.resolve();if(closed!==1)throw Error('Close notification did not arrive once');
                console.log('port refs passed');`,
              '/app/watch-target.txt':'before',
              '/app/self-watch-target.txt':'before',
              '/app/directory-watch-probe.mjs':`import {watch,writeFileSync} from 'node:fs';
                const directEvents=[];
                const direct=watch('/app/directory-probe',{persistent:false},(event,name)=>directEvents.push(String(name)));
                await new Promise((resolve,reject)=>{
                  const timeout=setTimeout(()=>{recursive.close();direct.close();reject(Error('Recursive watch timed out'))},3000);
                  const recursive=watch('/app/directory-probe',{recursive:true,encoding:'buffer'},(event,name)=>{
                    if(name.toString()!=='sub/late.txt')return;
                    clearTimeout(timeout);recursive.close();direct.close();
                    if(!Buffer.isBuffer(name)||directEvents.includes('sub/late.txt'))reject(Error('Directory watch filtering mismatch'));
                    else resolve();
                  });
                  setTimeout(()=>writeFileSync('/app/directory-probe/sub/late.txt','directory edit'),30);
                });console.log('directory watch passed');`,
              '/app/promise-watch-probe.mjs':`import {watch} from 'node:fs/promises';import {writeFileSync} from 'node:fs';
                const iterator=watch('/app/self-watch-target.txt');
                const next=iterator.next();
                setTimeout(()=>writeFileSync('/app/self-watch-target.txt','promise edit'),30);
                const timeout=setTimeout(()=>{iterator.return()},3000);
                const event=await next;clearTimeout(timeout);
                if(event.done||!['change','rename'].includes(event.value.eventType))throw Error('Promise watch event missing');
                const waiting=iterator.next();await iterator.return();
                if(!(await waiting).done)throw Error('Pending watch did not finish');
                const controller=new AbortController();const aborted=watch('/app/self-watch-target.txt',{signal:controller.signal});
                const pending=aborted.next();controller.abort();
                let rejected=false;try{await pending}catch(error){if(error.code!=='ABORT_ERR')throw error;rejected=true}
                if(!rejected)throw Error('Promise watch abort did not reject');
                console.log('promise watch passed');`,
              '/app/self-watch-probe.mjs':`import fs,{watch,writeFileSync,readFileSync} from 'node:fs';
                for(const options of [3,{signal:{}}]){
                  let rejected=false;
                  try{fs.watch('/app/self-watch-target.txt',options)}catch(error){if(error.code!=='ERR_INVALID_ARG_TYPE')throw error;rejected=true}
                  if(!rejected)throw Error('Invalid watch options accepted');
                }
                await new Promise((resolve,reject)=>{
                  const timeout=setTimeout(()=>{watcher.close();reject(Error('Self watch timed out'))},3000);
                  const watcher=watch('/app/self-watch-target.txt',(event)=>{
                    if(readFileSync('/app/self-watch-target.txt','utf8')!=='self edit')return;
                    console.log('self-watched:'+event);clearTimeout(timeout);watcher.close();resolve();
                  });
                  setTimeout(()=>writeFileSync('/app/self-watch-target.txt','self edit'),30);
                });`,
              '/app/watch-probe.mjs':`import {watch,readFileSync} from 'node:fs';
                await new Promise((resolve,reject)=>{
                  const timer=setTimeout(()=>{watcher.close();reject(Error('Watch event did not arrive'))},10000);
                  const watcher=watch('/app/watch-target.txt',(event)=>{
                    if(readFileSync('/app/watch-target.txt','utf8')!=='after')return;
                    console.log('watched:'+event);clearTimeout(timer);watcher.close();resolve();
                  });
                  console.log('watch-ready');
                });`,
              '/app/directory-probe.mjs':`import {readdirSync,readdir,promises,readlinkSync,readlink,realpath,lstatSync,lstat,stat,mkdir,rename,unlink,writeFileSync,readFileSync,existsSync,rmSync,access,accessSync} from 'node:fs';
                const root='/app/directory-probe';
                const entries=readdirSync(root,{recursive:true,withFileTypes:true});
                const file=entries.find(entry=>entry.name==='late.txt');
                const callback=await new Promise((resolve,reject)=>readdir(root,{recursive:true},(error,names)=>error?reject(error):resolve(names)));
                const link=new URL('file:///app/path-probe-link');
                const read=await new Promise((resolve,reject)=>readlink(link,(error,value)=>error?reject(error):resolve(value)));
                const resolved=await new Promise((resolve,reject)=>realpath.native(new URL('file:///app/index.mjs'),(error,value)=>error?reject(error):resolve(value)));
                const linkStat=await new Promise((resolve,reject)=>lstat(link,(error,value)=>error?reject(error):resolve(value)));
                const fileStat=await new Promise((resolve,reject)=>stat(root+'/sub/late.txt',{bigint:true},(error,value)=>error?reject(error):resolve(value)));
                if(!linkStat.isSymbolicLink()||!fileStat.isFile()||typeof fileStat.mtimeMs!=='bigint')throw Error('Live callback stat mismatch');
                accessSync(root+'/sub/late.txt');
                await new Promise((resolve,reject)=>access(new URL('file://'+root+'/sub/late.txt'),error=>error?reject(error):resolve()));
                await promises.access(root+'/sub/late.txt');
                let missing=false;
                try{await promises.access(root+'/missing.txt')}catch(error){if(error.code!=='ENOENT')throw error;missing=true}
                if(!missing)throw Error('Missing file passed access check');
                await new Promise((resolve,reject)=>mkdir(root+'/writes/deep',{recursive:true,mode:448},error=>error?reject(error):resolve()));
                if(((await promises.stat(root+'/writes/deep')).mode&511)!==448)throw Error('Directory mode mismatch');
                writeFileSync(root+'/writes/deep/source.txt','live write');
                await new Promise((resolve,reject)=>rename(root+'/writes/deep/source.txt',root+'/writes/deep/moved.txt',error=>error?reject(error):resolve()));
                if(readFileSync(root+'/writes/deep/moved.txt','utf8')!=='live write')throw Error('Live rename mismatch');
                await new Promise((resolve,reject)=>unlink(root+'/writes/deep/moved.txt',error=>error?reject(error):resolve()));
                if(existsSync(root+'/writes/deep/moved.txt'))throw Error('Live unlink mismatch');
                rmSync(root+'/writes',{recursive:true});
                console.log(JSON.stringify({paths:{sync:readlinkSync(link),callback:read,promise:(await promises.readlink(link,{encoding:'buffer'})).toString(),
                  native:resolved,realpath:await promises.realpath('/app/index.mjs'),symlink:lstatSync(link).isSymbolicLink()},
                  names:callback.sort(),promise:(await promises.readdir(root,{recursive:true})).sort(),
                  buffers:readdirSync(root,'buffer').map(name=>name.toString()).sort(),
                  file:{parent:file.parentPath,isFile:file.isFile(),isSocket:file.isSocket(),isFIFO:file.isFIFO()}}));`,
            },{workerURL:window.nativeWorkerURL,workerType:classic?'classic':'module',entry:'index.mjs',serveFetchEntry:true,
              env:{...(classic?{NATIVE_CLASSIC_VM:'1'}:{}),...(browserModules?{NATIVE_BROWSER_MODULES:'1'}:{})}})
            try{
              await dev.ready
              const channel=new MessageChannel()
              await dev.mkdir('/app/native-directory/nested',{recursive:true,mode:0o750})
              const directories=await dev.listDirectory('/app/native-directory')
              if(directories.length!==1||directories[0].name!=='nested'||directories[0].type!=='directory')throw Error('Native mkdir did not create the requested directory')
              const shape=await dev.snapshotWorkspace()
              if((shape.directoryModes['/app/native-directory/nested']&0o777)!==0o750)throw Error('Native mkdir did not preserve directory mode')
              const directoryRevision=dev.workspaceRevision()
              await dev.mkdir('/app/native-directory/nested',{recursive:true,mode:0o700})
              if(dev.workspaceRevision()!==directoryRevision)throw Error('No-op mkdir advanced workspace revision')
              await dev.writeFile('/app/native-directory/nested/bytes.bin',new Uint8Array([0,128,255]))
              const renameRevision=dev.workspaceRevision()
              await dev.rename('/app/native-directory/nested/bytes.bin','/app/native-directory/nested/moved.bin')
              if(dev.workspaceRevision()!==renameRevision+1)throw Error('Native rename did not advance revision')
              await dev.rename('/app/native-directory/nested/moved.bin','/app/native-directory/nested/moved.bin')
              if(dev.workspaceRevision()!==renameRevision+1)throw Error('No-op rename advanced revision')
              if([...await dev.readFile('/app/native-directory/nested/moved.bin')].join(',')!=='0,128,255')throw Error('Native rename changed binary bytes')
              const removeRevision=dev.workspaceRevision()
              await dev.remove('/app/native-directory/nested/moved.bin')
              if(dev.workspaceRevision()!==removeRevision+1)throw Error('Native remove did not advance revision')
              await dev.remove('/app/native-directory/nested/moved.bin',{force:true})
              if(dev.workspaceRevision()!==removeRevision+1)throw Error('No-op native remove advanced revision')
              let removedReadRejected=false
              try{await dev.readFile('/app/native-directory/nested/moved.bin')}catch{removedReadRejected=true}
              if(!removedReadRejected)throw Error('Removed native file remains readable')
              const retained=await dev.snapshotWorkspace()
              if((retained.directoryModes['/app/native-directory/nested']&0o777)!==0o750)throw Error('No-op mkdir changed directory mode')
              for(const [path,options,expected] of [
                ['/app/invalid-directory',{mode:-1},'Invalid directory mode'],
                ['/app/path-probe-link/child',{recursive:true},'symbolic link'],
                ['/outside-directory',{},'inside /app'],
              ]){
                let rejected=false
                try{await dev.mkdir(path,options)}catch(error){if(!String(error).includes(expected))throw error;rejected=true}
                if(!rejected)throw Error('Native mkdir accepted invalid operation: '+path)
              }
              const scratch=await dev.terminalCommand('mkdir -p /tmp/shell-probe; cd /tmp/shell-probe; printf scratch > value.txt; cat value.txt')
              if(scratch.exitCode!==0||scratch.cwd!=='/tmp/shell-probe'||scratch.stdout!=='scratch')throw Error('One-shot scratch shell failed: '+JSON.stringify(scratch))
              const session=await dev.openTerminalSession('/tmp')
              try{
                let rejected=false
                try{await session.runCommand('x'.repeat(8193))}
                catch(error){
                  if(!String(error).includes('Terminal command exceeds limit'))throw error
                  rejected=true
                }
                if(!rejected)throw Error('Persistent shell accepted an oversized command')
                const revision=dev.workspaceRevision()
                const mutation=await session.runCommand('touch /project/revision-probe.txt')
                if(mutation.exitCode!==0||dev.workspaceRevision()!==revision+1)throw Error('Persistent mutation did not advance workspace revision')
                const changed=await session.runCommand('cd /tmp/shell-probe')
                const resumed=await session.runCommand('cat value.txt')
                if(dev.workspaceRevision()!==revision+1)throw Error('Read-only persistent commands advanced workspace revision')
                if(changed.exitCode!==0||resumed.exitCode!==0||resumed.cwd!=='/tmp/shell-probe'||resumed.stdout!=='scratch')throw Error('Persistent scratch shell failed: '+JSON.stringify({changed,resumed}))
              }finally{await session.dispose()}
              const result=dev.terminalCommand('node command.mjs hello','/app',undefined,undefined,channel.port2)
              channel.port1.postMessage({type:'data',bytes:new TextEncoder().encode('from stdin')})
              channel.port1.postMessage({type:'end'})
              const terminal=await result
              channel.port1.close()
              let file=null
              try{file=new TextDecoder().decode(await dev.readFile('/app/command-output.txt'))}catch{}
              const controller=new AbortController()
              let sawOutput
              const output=new Promise(resolve=>{sawOutput=resolve})
              const interrupted=dev.terminalCommand('node long.mjs','/app',text=>{
                if(text.includes('started'))sawOutput()
              },controller.signal)
              let earlyOutput=true
              try{await Promise.race([output,new Promise((_,reject)=>setTimeout(()=>reject(Error('No early node output')),15000))])}
              catch{earlyOutput=false}
              controller.abort()
              const stopped=await interrupted
              let lateFile=false
              try{await dev.readFile('/app/should-not-exist.txt');lateFile=true}catch{}
              const after=await dev.terminalCommand('pwd')
              const asyncCli=await dev.terminalCommand('node async-cli.cjs')
              const dynamic=await dev.terminalCommand('node dynamic-entry.mjs')
              await dev.writeFile('/app/directory-probe/sub/late.txt','created after boot')
              const directory=await dev.terminalCommand('node directory-probe.mjs')
              if(directory.exitCode!==0)throw Error(`Directory probe failed: ${JSON.stringify(directory)}`)
              const directoryResult=JSON.parse(directory.stdout)
              let announceWatch
              const watchReady=new Promise(resolve=>{announceWatch=resolve})
              const watchController=new AbortController()
              let watchOutput=''
              const watching=dev.terminalCommand('node watch-probe.mjs','/app',text=>{
                watchOutput+=text
                if(text.includes('watch-ready'))announceWatch()
              },watchController.signal)
              await Promise.race([watchReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('Watch command did not start')),15000))])
              await dev.writeFile('/app/watch-target.txt','after')
              const watchTimer=setTimeout(()=>watchController.abort(),3000)
              let watchResult
              try{watchResult=await watching}finally{clearTimeout(watchTimer)}
              const watchSummary={exitCode:watchResult.exitCode,changed:/watched:(change|rename)/.test(watchOutput)}
              const selfWatch=await dev.terminalCommand('node self-watch-probe.mjs')
              const selfWatchSummary={exitCode:selfWatch.exitCode,changed:/self-watched:(change|rename)/.test(selfWatch.stdout)}
              const promiseWatch=await dev.terminalCommand('node promise-watch-probe.mjs')
              const promiseWatchSummary={exitCode:promiseWatch.exitCode,passed:promiseWatch.stdout.includes('promise watch passed')}
              const directoryWatch=await dev.terminalCommand('node directory-watch-probe.mjs')
              const directoryWatchSummary={exitCode:directoryWatch.exitCode,passed:directoryWatch.stdout.includes('directory watch passed')}
              const portResult=await dev.terminalCommand('node port-ref-probe.mjs')
              const portRefs={exitCode:portResult.exitCode,passed:portResult.stdout.includes('port refs passed')}
              const workerResult=await dev.terminalCommand('node worker-owner.mjs')
              const workerLifetime={exitCode:workerResult.exitCode,stdout:workerResult.stdout,stderr:workerResult.stderr}
              const workerTerminationResult=await dev.terminalCommand('node worker-terminate.mjs')
              const workerTermination={exitCode:workerTerminationResult.exitCode,stdout:workerTerminationResult.stdout,stderr:workerTerminationResult.stderr}
              const chainedResult=await dev.terminalCommand('node chained-timers.mjs')
              const chainedTimers={exitCode:chainedResult.exitCode,stdout:chainedResult.stdout,stderr:chainedResult.stderr}
              const pipelineResult=await dev.terminalCommand('node pipeline-probe.mjs')
              const pipelineFailures={exitCode:pipelineResult.exitCode,stdout:pipelineResult.stdout,stderr:pipelineResult.stderr}
              return {terminal,file,earlyOutput,stopped,lateFile,after,asyncCli,dynamic,directoryResult,watchSummary,selfWatchSummary,promiseWatchSummary,directoryWatchSummary,portRefs,workerLifetime,workerTermination,chainedTimers,pipelineFailures}
            }catch(error){return {error:String(error),diagnostics:dev.diagnostics}}
            finally{await dev.dispose()}
          },{classic:process.env.NATIVE_CLASSIC_VM==='1',browserModules:process.env.NATIVE_BROWSER_MODULES==='1'})
          assert.equal(command.error,undefined,`${browserType.name()} terminal workflow: ${JSON.stringify(command)}`)
          for(const key of ['terminal','after','asyncCli','dynamic']){
            assert.equal(JSON.parse(command[key].shellState).version,1,
              `${browserType.name()} ${key} did not return a shell state`)
          }
          const commandWithoutShellState=Object.fromEntries(Object.entries(command).map(([key,value])=>[
            key,value&&typeof value==='object'&&'shellState' in value
              ?Object.fromEntries(Object.entries(value).filter(([field])=>field!=='shellState')):value,
          ]))
          assert.deepEqual(commandWithoutShellState,{terminal:{cwd:'/app',stdout:'hello hello\ninput:from stdin\n',stderr:'warning\n',
            exitCode:0,changedPaths:['/app/command-output.txt']},file:'finished',earlyOutput:true,
            stopped:{cwd:'/app',stdout:'',stderr:'',exitCode:130,changedPaths:[]},lateFile:false,
            after:{cwd:'/app',stdout:'/project\n',stderr:'',exitCode:0,changedPaths:[]},
            asyncCli:{cwd:'/app',stdout:'async command complete\n',stderr:'',exitCode:0,changedPaths:[]},
            dynamic:{cwd:'/app',stdout:'dynamic import complete\n',stderr:'',exitCode:0,changedPaths:[]},
            directoryResult:{paths:{sync:'index.mjs',callback:'index.mjs',promise:'index.mjs',native:'/app/index.mjs',realpath:'/app/index.mjs',symlink:true},
              names:['sub','sub/late.txt'],promise:['sub','sub/late.txt'],buffers:['sub'],
              file:{parent:'/app/directory-probe/sub',isFile:true,isSocket:false,isFIFO:false}},watchSummary:{exitCode:0,changed:true},selfWatchSummary:{exitCode:0,changed:true},promiseWatchSummary:{exitCode:0,passed:true},directoryWatchSummary:{exitCode:0,passed:true},portRefs:{exitCode:0,passed:true},
              workerLifetime:{exitCode:0,stdout:'worker completed\nworker exit:0\n',stderr:''},
              workerTermination:{exitCode:0,stdout:'worker termination passed\n',stderr:''},
              chainedTimers:{exitCode:0,stdout:'chained timers finished\n',stderr:''},
              pipelineFailures:{exitCode:0,stdout:'pipeline failures passed\n',stderr:''}},
            `${browserType.name()} terminal node command: ${JSON.stringify(commandWithoutShellState)}`)
          if(process.env.NATIVE_TERMINAL_LONG==='1'){
            const long=await page.evaluate(async()=>{
              const {NativeDevServer}=await import('/native-sdk/index.js')
              const dev=new NativeDevServer({
                '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
                '/app/slow.mjs':'await new Promise(resolve=>setTimeout(resolve,36000));console.log("still running")',
              },{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
              try{await dev.ready;return await dev.terminalCommand('node slow.mjs')}
              finally{await dev.dispose()}
            })
            assert.deepEqual(long,{cwd:'/app',stdout:'still running\n',stderr:'',exitCode:0,changedPaths:[]},
              `${browserType.name()} terminal command must outlive the old 35-second server limit: ${JSON.stringify(long)}`)
          }
          if(process.env.NATIVE_TERMINAL_SERVER==='1'){
            const listening=await page.evaluate(async()=>{
              const {NativeDevServer}=await import('/native-sdk/index.js')
              const dev=new NativeDevServer({
                '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
                '/app/server.mjs':`import {createServer} from 'node:http';
                  const server=createServer((request,response)=>{
                    if(request.url==='/stop')response.on('finish',()=>setTimeout(()=>{
                      server.close(()=>console.log('closed'));
                      server.closeAllConnections();
                    },100));
                    response.end(request.url==='/stop'?'stopping':'hello from command');
                  });
                  server.listen(0,()=>console.log('listening:'+server.address().port));`,
                '/app/hold.mjs':`import {createServer} from 'node:http';
                  const server=createServer((request,response)=>response.end('holding'));
                  server.listen(0,()=>console.log('holding:'+server.address().port));`,
                '/app/parent.mjs':`import {Worker} from 'node:worker_threads';
                  const child=new Worker('/app/nested.mjs');
                  child.on('message',port=>console.log('nested:'+port));
                  child.on('error',error=>{console.error(error);process.exit(1)});
                  setInterval(()=>{},1000);`,
                '/app/nested.mjs':`import {createServer} from 'node:http';
                  import {parentPort} from 'node:worker_threads';
                  createServer((request,response)=>response.end('nested'))
                    .listen(0,function(){parentPort.postMessage(this.address().port)});`,
                '/app/reuse.mjs':`import {createServer} from 'node:http';
                  const server=createServer((request,response)=>response.end('reused'));
                  server.on('error',error=>{console.error(error);process.exit(1)});
                  server.listen(Number(process.argv[2]),()=>{console.log('reused');server.close()});`,
              },{workerURL:window.nativeWorkerURL,entry:'index.mjs',serveFetchEntry:true})
              try{
                const previewPort=await dev.ready
                await dev.writeFile('/app/clash.mjs',`import {createServer} from 'node:http';
                  const server=createServer((request,response)=>response.end('unexpected'));
                  server.on('error',error=>console.log('collision:'+error.code));
                  server.listen(Number(process.argv[2]));`)
                const collision=await dev.terminalCommand(`node clash.mjs ${previewPort}`)
                let announcePort
                const output=[]
                const portReady=new Promise(resolve=>{announcePort=resolve})
                const result=dev.terminalCommand('node server.mjs','/app',text=>{
                  output.push(text)
                  const match=/listening:(\d+)/.exec(text)
                  if(match)announcePort(Number(match[1]))
                })
                const port=await Promise.race([portReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('Command server did not listen')),15000))])
                await dev.ports()
                const request=async path=>{
                  try{
                    const response=await dev.previewServer(port).fetch(new Request(`http://127.0.0.1:${port}${path}`))
                    return {status:response.status,body:await response.text()}
                  }catch(error){return {error:String(error)}}
                }
                const hello=await request('/')
                const stop=await request('/stop')
                const completed=await Promise.race([result,
                  new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),3000))])
                if(completed?.timeout)return {port,hello,stop,result:completed,output,ports:await dev.ports()}
                const controller=new AbortController()
                let announceHold
                const holdReady=new Promise(resolve=>{announceHold=resolve})
                const holding=dev.terminalCommand('node hold.mjs','/app',text=>{
                  output.push(text)
                  const match=/holding:(\d+)/.exec(text)
                  if(match)announceHold(Number(match[1]))
                },controller.signal)
                const holdPort=await Promise.race([holdReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('Held command did not listen')),15000))])
                const heldPorts=await dev.ports()
                controller.abort()
                const interrupted=await holding
                const ports=await dev.ports()
                const after=await dev.terminalCommand('pwd')
                const nestedController=new AbortController()
                let announceNested
                const nestedReady=new Promise(resolve=>{announceNested=resolve})
                const nested=dev.terminalCommand('node parent.mjs','/app',text=>{
                  const match=/nested:(\d+)/.exec(text)
                  if(match)announceNested(Number(match[1]))
                },nestedController.signal)
                const nestedPort=await Promise.race([nestedReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('Nested worker did not listen')),15000))])
                await dev.ports()
                const nestedResponse=await dev.previewServer(nestedPort).fetch(new Request(`http://127.0.0.1:${nestedPort}/`))
                const nestedBody=await nestedResponse.text()
                nestedController.abort()
                const nestedInterrupted=await nested
                const nestedPortsAfter=await dev.ports()
                const reused=await dev.terminalCommand(`node reuse.mjs ${nestedPort}`)
                return {port,hello,stop,result:completed,output,holdPort,heldPorts,ports,interrupted,after,collision,
                  nestedPort,nestedBody,nestedInterrupted,nestedPortsAfter,reused}
              }finally{await dev.dispose()}
            })
            assert.ok(listening.port>0,`${browserType.name()} command server port: ${JSON.stringify(listening)}`)
            assert.notEqual(listening.port,listening.holdPort,`${browserType.name()} nested ephemeral ports collided`)
            for(const key of ['result','after','collision']){
              assert.equal(JSON.parse(listening[key].shellState).version,1,
                `${browserType.name()} ${key} did not return a shell state`)
            }
            const withoutShellState=value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='shellState'))
            assert.equal(listening.nestedBody,'nested')
            assert.equal(listening.nestedInterrupted.exitCode,130)
            assert.ok(!listening.nestedPortsAfter.includes(listening.nestedPort),`${browserType.name()} nested port leaked`)
            assert.equal(listening.reused.exitCode,0,`${browserType.name()} nested port reuse: ${JSON.stringify(listening.reused)}`)
            assert.equal(listening.reused.stdout,'reused\n')
            assert.deepEqual({hello:listening.hello,stop:listening.stop,result:withoutShellState(listening.result)},
              {hello:{status:200,body:'hello from command'},stop:{status:200,body:'stopping'},
                result:{cwd:'/app',stdout:'',stderr:'',exitCode:0,changedPaths:[]}},
              `${browserType.name()} foreground command server: ${JSON.stringify(listening)}`)
            assert.ok(listening.heldPorts.includes(listening.holdPort),`${browserType.name()} held server port: ${JSON.stringify(listening)}`)
            assert.ok(!listening.ports.includes(listening.holdPort),`${browserType.name()} interrupted server port leaked: ${JSON.stringify(listening)}`)
            assert.deepEqual(withoutShellState(listening.collision),{cwd:'/app',stdout:'collision:EADDRINUSE\n',stderr:'',exitCode:0,changedPaths:[]},
              `${browserType.name()} explicit port collision: ${JSON.stringify(listening)}`)
            assert.deepEqual(listening.interrupted,{cwd:'/app',stdout:'',stderr:'',exitCode:130,changedPaths:[]},
              `${browserType.name()} interrupted server command: ${JSON.stringify(listening)}`)
            assert.deepEqual(withoutShellState(listening.after),{cwd:'/app',stdout:'/project\n',stderr:'',exitCode:0,changedPaths:[]},
              `${browserType.name()} terminal after server interruption: ${JSON.stringify(listening)}`)
          }
          continue
        }
        if(process.env.NATIVE_THREAD_NETWORK==='1'){
          const thread=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/main.mjs':`import {Worker} from 'node:worker_threads';import {writeFileSync} from 'node:fs';
                const worker=new Worker('/app/child.mjs');
                worker.on('message',message=>writeFileSync('/app/child-port.txt',String(message.port)));
                worker.on('error',error=>writeFileSync('/app/child-error.txt',String(error)));`,
              '/app/child.mjs':`import {createServer} from 'node:http';import {parentPort} from 'node:worker_threads';
                const server=createServer((_request,response)=>{response.end('nested worker response')});
                server.listen(0,'127.0.0.1',()=>parentPort.postMessage({port:server.address().port}));`,
            },{workerURL:window.nativeWorkerURL,entry:'main.mjs'})
            try{
              await dev.ready
              let port
              for(let attempt=0;attempt<100;attempt++){
                try{port=Number(new TextDecoder().decode(await dev.readFile('/app/child-port.txt')));break}
                catch{await new Promise(resolve=>setTimeout(resolve,100))}
              }
              if(!port)return {error:'child did not open a port',diagnostics:dev.diagnostics}
              const ports=await dev.ports()
              try{
                const response=await dev.fetch(new Request(`http://127.0.0.1:${port}/`))
                return {port,status:response.status,body:await response.text(),ports}
              }catch(error){return {port,error:String(error),ports,diagnostics:dev.diagnostics}}
            }finally{await dev.dispose()}
          })
          assert.equal(thread.status,200,`${browserType.name()} nested worker network: ${JSON.stringify(thread)}`)
          assert.equal(thread.body,'nested worker response')
          continue
        }
        if(process.env.NATIVE_STATIC_STREAM==='1'){
          const staticStream=await page.evaluate(async()=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer({
              '/app/package.json':'{"type":"module"}',
              '/app/asset.txt':'Native static stream '.repeat(60000),
              '/app/server.mjs':`import {createServer} from 'node:http';import {createReadStream,readFileSync} from 'node:fs';
                createServer((request,response)=>{
                  if(request.url==='/state'){response.end(typeof response.finished+':'+response.finished);return}
                  if(request.url==='/direct'){response.end(readFileSync('/app/asset.txt'));return}
                  const bytes=readFileSync('/app/asset.txt').length
                  response.setHeader('Content-Length',bytes)
                  createReadStream('/app/asset.txt',{maxage:0,root:'/app',start:0,end:bytes-1}).pipe(response)
                }).listen(3000)`,
            },{workerURL:window.nativeWorkerURL,entry:'server.mjs'})
            try{
              await dev.ready
              await dev.ports()
              const state=await(await dev.fetch(new Request('http://127.0.0.1:3000/state'))).text()
              const direct=await dev.fetch(new Request('http://127.0.0.1:3000/direct',{signal:AbortSignal.timeout(5000)}))
              const directText=await direct.text()
              try{
                const streamed=await dev.fetch(new Request('http://127.0.0.1:3000/asset.txt',{signal:AbortSignal.timeout(5000)}))
                return {state,directStatus:direct.status,directBytes:directText.length,streamStatus:streamed.status,streamBytes:(await streamed.text()).length,diagnostics:dev.diagnostics}
              }catch(error){return {state,directStatus:direct.status,directBytes:directText.length,streamError:String(error),diagnostics:dev.diagnostics}}
            }finally{await dev.dispose()}
          })
          assert.equal(staticStream.state,'boolean:false',JSON.stringify(staticStream))
          assert.equal(staticStream.directStatus,200,JSON.stringify(staticStream))
          assert.equal(staticStream.streamStatus,200,JSON.stringify(staticStream))
          assert.equal(staticStream.streamBytes,staticStream.directBytes,JSON.stringify(staticStream))
          continue
        }
        if(process.env.NATIVE_TERMINAL_VITE_DEV==='1'&&['react-counter','solid-counter'].includes(realExample)){
          const terminalVite=await page.evaluate(async({files,lock,realExample})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=new NativeDevServer(files,{workerURL:window.nativeWorkerURL,lock,script:'dev'})
            const controller=new AbortController()
            let output=''
            try{
              const primaryPort=await dev.ready
              let announcePort
              const portReady=new Promise(resolve=>{announcePort=resolve})
              const command=dev.terminalCommand('pnpm run dev','/app',text=>{
                output+=text
                const match=/Local:\s+http:\/\/localhost:(\d+)\//.exec(output)
                if(match)announcePort(Number(match[1]))
              },controller.signal)
              const port=await Promise.race([portReady,
                command.then(result=>{throw Error(`Vite dev exited before listening: ${JSON.stringify(result)}`)}),
                new Promise((_,reject)=>setTimeout(()=>reject(Error('Vite dev did not announce a port')),45000))])
              const listening=(await dev.ports()).includes(port)
              const response=await dev.fetch(new Request(`http://127.0.0.1:${port}/`))
              const body=await response.text()
              const client=await dev.fetch(new Request(`http://127.0.0.1:${port}/@vite/client`))
              const moduleURL=`http://127.0.0.1:${port}/src/routes/index.tsx`
              const moduleBefore=await dev.fetch(new Request(moduleURL))
              const beforeCode=await moduleBefore.text()
              const componentCode=async wrapper=>{
                const splitPath=/import\("([^"]+tsr-split=component[^"]*)"\)/.exec(wrapper)?.[1]
                if(!splitPath)return {status:200,code:wrapper}
                const split=await dev.fetch(new Request(`http://127.0.0.1:${port}${splitPath}`))
                return {status:split.status,code:await split.text()}
              }
              const componentBefore=await componentCode(beforeCode)
              const route='/app/src/routes/index.tsx'
              const source=new TextDecoder().decode(await dev.readFile(route))
              const original=realExample==='solid-counter'?'Hello world!':'Add 1 to'
              const updated=realExample==='solid-counter'?'Terminal Vite says hello!':'Terminal Vite add 1 to'
              if(!source.includes(original))throw Error('Counter route did not contain the edit target')
              await dev.writeFile(route,source.replace(original,updated))
              let moduleAfterStatus=0,afterCode=''
              for(let attempt=0;attempt<20;attempt++){
                const moduleAfter=await dev.fetch(new Request(moduleURL))
                moduleAfterStatus=moduleAfter.status
                const componentAfter=await componentCode(await moduleAfter.text())
                afterCode=componentAfter.code
                if(afterCode.includes(updated))break
                await new Promise(resolve=>setTimeout(resolve,250))
              }
              controller.abort()
              const stopped=await command
              const afterStop=await dev.terminalCommand('pwd')
              const secondController=new AbortController()
              let secondOutput=''
              let announceSecondPort
              const secondReady=new Promise(resolve=>{announceSecondPort=resolve})
              const secondCommand=dev.terminalCommand('pnpm run dev','/app',text=>{
                secondOutput+=text
                const match=/Local:\s+http:\/\/localhost:(\d+)\//.exec(secondOutput)
                if(match)announceSecondPort(Number(match[1]))
              },secondController.signal)
              const secondPort=await Promise.race([secondReady,
                secondCommand.then(result=>{throw Error(`Second Vite dev exited before listening: ${JSON.stringify(result)}`)}),
                new Promise((_,reject)=>setTimeout(()=>reject(Error('Second Vite dev did not announce a port')),45000))])
              const secondResponse=await dev.fetch(new Request(`http://127.0.0.1:${secondPort}/`))
              secondController.abort()
              const secondStopped=await secondCommand
              return {primaryPort,port,listening,status:response.status,body:body.slice(0,200),
                clientStatus:client.status,moduleBeforeStatus:moduleBefore.status,splitBeforeStatus:componentBefore.status,
                moduleBeforeUpdated:componentBefore.code.includes(updated),moduleAfterStatus,
                moduleAfterUpdated:afterCode.includes(updated),
                stopped:stopped.exitCode,afterStop:afterStop.stdout,afterStopExit:afterStop.exitCode,
                secondPort,secondStatus:secondResponse.status,secondStopped:secondStopped.exitCode,
                portsAfter:await dev.ports(),output,secondOutput}
            }catch(error){return {error:String(error),output,diagnostics:dev.diagnostics}}
            finally{controller.abort();await dev.dispose()}
          },{files:realCounter,lock:exactLock,realExample})
          assert.equal(terminalVite.error,undefined,`${browserType.name()} terminal Vite dev: ${JSON.stringify(terminalVite)}`)
          assert.notEqual(terminalVite.port,terminalVite.primaryPort)
          assert.equal(terminalVite.listening,true)
          assert.equal(terminalVite.status,200)
          assert.equal(terminalVite.clientStatus,200)
          assert.equal(terminalVite.moduleBeforeStatus,200)
          assert.equal(terminalVite.splitBeforeStatus,200)
          assert.equal(terminalVite.moduleBeforeUpdated,false)
          assert.equal(terminalVite.moduleAfterStatus,200)
          assert.equal(terminalVite.moduleAfterUpdated,true,`${browserType.name()} terminal Vite server did not serve the live route edit: ${JSON.stringify(terminalVite)}`)
          assert.equal(terminalVite.stopped,130)
          assert.equal(terminalVite.afterStop,'/project\n')
          assert.equal(terminalVite.afterStopExit,0)
          assert.equal(terminalVite.secondStatus,200)
          assert.equal(terminalVite.secondStopped,130)
          assert.ok(!terminalVite.portsAfter.includes(terminalVite.port))
          assert.ok(!terminalVite.portsAfter.includes(terminalVite.secondPort))
          continue
        }
        if(process.env.NATIVE_AUTO_PROJECT_LOCK==='1'&&realCounter){
          const lockText=await readFile(resolve(realFixture,'package-lock.json'),'utf8')
          const auto=await page.evaluate(async({files,lockText,packageName,expectedPort,declaredCommands,buildMode,scriptBuild,terminalBuild,realExample,productionPreview,previewOrigin,shrinkwrap,browserModules})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const lockFiles=shrinkwrap?{'/app/npm-shrinkwrap.json':lockText,'/app/package-lock.json':'{"lockfileVersion":1}'}:
              {'/app/package-lock.json':lockText}
            const mounted=declaredCommands
              ?Object.fromEntries(Object.entries({...files,...lockFiles}).map(([path,bytes])=>['/project'+path.slice('/app'.length),bytes]))
              :{...files,...lockFiles}
            const root=declaredCommands?'/project':'/app'
            const runtimeOptions=shrinkwrap?{workerURL:'/missing-fallback.js',runtimeCandidates:[
              {workerURL:window.nativeWorkerURL,toolchain:{vite:'8.3.1',rolldown:'1.2.11'}},
            ]}:{workerURL:window.nativeWorkerURL}
            if(browserModules)runtimeOptions.env={NATIVE_BROWSER_MODULES:'1'}
            const dev=new NativeDevServer(mounted,declaredCommands
              ?{...runtimeOptions,workspaceRoot:root,installCommand:'pnpm install',startCommand:'pnpm run dev'}
              :{...runtimeOptions,script:'dev'})
            try{
              const readyPort=await dev.ready
              const port=expectedPort??readyPort
              if(!port)throw Error('Project script did not report a preview port')
              if(expectedPort){
                let listening=false
                for(let attempt=0;attempt<100;attempt++){
                  listening=(await dev.ports()).includes(expectedPort)
                  if(listening)break
                  await new Promise(resolve=>setTimeout(resolve,100))
                }
                if(!listening)throw Error(`Project did not listen on port ${expectedPort}`)
              }
              const installed=JSON.parse(new TextDecoder().decode(await dev.readFile(`${root}/node_modules/${packageName}/package.json`))).name
              const response=await dev.fetch(new Request(`http://127.0.0.1:${port}/`))
              const body=(await response.text()).slice(0,1000)
              if(!buildMode)return {installed,port,status:response.status,body,progress:dev.progress}
              let outputs
              if(terminalBuild){
                const command=await dev.terminalCommand('pnpm run build',root)
                if(command.exitCode!==0)throw Error(`Declared build CLI failed: ${JSON.stringify({exitCode:command.exitCode,stdout:command.stdout,stderr:command.stderr})}`)
                const built=await dev.snapshot()
                outputs=Object.keys(built).filter(path=>path.startsWith(root+'/dist/')||path.startsWith(root+'/.output/'))
                console.log('DECLARED_BUILD_CLI',JSON.stringify({exitCode:command.exitCode,stdout:command.stdout,stderr:command.stderr,outputs:outputs.length}))
              }else outputs=scriptBuild?(await dev.runBuildScript()).outputFiles:await dev.build()
              if(realExample==='react-router-ssr'&&!scriptBuild&&!terminalBuild)outputs.push(...await dev.build({ssr:true}))
              const entry=realExample==='react-basic'?`${root}/.output/server/index.mjs`
                :realExample==='react-router-ssr'?`${root}/dist/server/entry-server.js`
                :`${root}/dist/server/server.js`
              const entryBytes=(await dev.readFile(entry)).byteLength
              const snapshot=await dev.snapshot()
              await dev.dispose()
              const production=new NativeDevServer(snapshot,{workerURL:window.nativeWorkerURL,workspaceRoot:root,
                installDependencies:false,entry:realExample==='react-router-ssr'?'server.js':entry,
                env:{NODE_ENV:'production',...(browserModules?{NATIVE_BROWSER_MODULES:'1'}:{})},serveFetchEntry:entry.endsWith('/dist/server/server.js'),
                staticRoot:entry.endsWith('/dist/server/server.js')?`${root}/dist/client`:undefined})
              let keepProduction=false
              try{
                await production.ready
                let ports=[]
                for(let attempt=0;attempt<100;attempt++){
                  ports=await production.ports()
                  if(ports.length)break
                  await new Promise(resolve=>setTimeout(resolve,100))
                }
                if(!ports.length)throw Error('Production server did not listen')
                const result=await production.fetch(new Request(`http://127.0.0.1:${ports[0]}/`))
                const productionBody=(await result.text()).slice(0,1000)
                if(productionPreview){
                  const {URLPreview}=await import('/native-sdk/index.js')
                  const target=document.createElement('div')
                  target.id='native-production-preview'
                  document.body.append(target)
                  window.nativeProductionPreview=await URLPreview.mount(target,{origin:previewOrigin,
                    server:production.previewServer(ports[0]),
                    scriptOrigins:realExample==='react-router-ssr'?['https://unpkg.com']:undefined,
                    connectOrigins:realExample==='react-router-ssr'?['https://jsonplaceholder.typicode.com']:undefined})
                  window.nativeProductionDev=production
                  keepProduction=true
                }
                return {installed,port,status:response.status,body,progress:dev.progress,
                  outputs:outputs.length,allOutputsInWorkspace:outputs.every(path=>path.startsWith(root+'/')),
                  entryBytes,productionStatus:result.status,productionBody,
                  productionInstalled:production.progress.some(item=>item.phase==='dependencies-install-started')}
              }finally{if(!keepProduction)await production.dispose()}
            }catch(error){return {error:String(error),progress:dev.progress,diagnostics:dev.diagnostics}}
            finally{await dev.dispose()}
          },{files:realCounter,lockText,packageName:realKind==='solid'?'solid-js':'react',expectedPort:realExample==='react-router-ssr'?3000:undefined,declaredCommands:process.env.NATIVE_DECLARED_COMMANDS==='1',buildMode:process.env.NATIVE_REAL_BUILD==='1',scriptBuild:process.env.NATIVE_REAL_BUILD_SCRIPT==='1',terminalBuild:process.env.NATIVE_REAL_BUILD_CLI==='1',realExample,
            productionPreview:process.env.NATIVE_PRODUCTION_PREVIEW==='1',previewOrigin,shrinkwrap:process.env.NATIVE_AUTO_SHRINKWRAP==='1',browserModules:process.env.NATIVE_BROWSER_MODULES==='1'})
          assert.equal(auto.error,undefined,`${browserType.name()} automatic project lock: ${JSON.stringify(auto)}`)
          assert.equal(auto.installed,realKind==='solid'?'solid-js':'react')
          assert.equal(auto.status,200,`${browserType.name()} preview response: ${JSON.stringify(auto)}`)
          assert.ok(auto.progress.some(item=>item.phase==='dependency-lock-planned'))
          if(process.env.NATIVE_REAL_BUILD==='1'){
            assert.ok(auto.outputs>0&&auto.allOutputsInWorkspace,`${browserType.name()} production outputs: ${JSON.stringify(auto)}`)
            assert.ok(auto.entryBytes>0,`${browserType.name()} production entry: ${JSON.stringify(auto)}`)
            assert.equal(auto.productionStatus,200,`${browserType.name()} production server: ${JSON.stringify(auto)}`)
            assert.equal(auto.productionInstalled,false,`${browserType.name()} production reinstalled dependencies: ${JSON.stringify(auto)}`)
            if(process.env.NATIVE_PRODUCTION_PREVIEW==='1'){
              await runWithCleanup(async()=>{try{
                const frame=page.frameLocator('#native-production-preview iframe')
                await expect.poll(()=>page.evaluate(()=>window.nativeProductionPreview.requests.some(request=>request.pathname.endsWith('.js')&&request.status===200)),{timeout:30000}).toBe(true)
                if(realExample==='react-router-ssr'){
                  await expect(frame.getByText('Welcome Home!')).toBeVisible({timeout:30000})
                  await expect.poll(()=>frame.locator('html').evaluate(()=>Object.keys(document).some(key=>key.startsWith('__reactContainer$'))),{timeout:30000}).toBe(true)
                  await frame.getByRole('link',{name:'Posts'}).click()
                  await expect(frame.getByText('Select a post.')).toBeVisible({timeout:30000})
                }else if(realExample==='react-basic'){
                  await expect(frame.getByText('Welcome Home!!!')).toBeVisible({timeout:30000})
                  await expect.poll(()=>frame.locator('html').evaluate(()=>Object.keys(document).some(key=>key.startsWith('__reactContainer$'))),{timeout:30000}).toBe(true)
                  await frame.getByRole('link',{name:'Deferred'}).click()
                  await expect(frame.getByText('Hello deferred!')).toBeVisible({timeout:30000})
                }else if(realExample==='react-streaming'){
                  await expect(frame.getByText('Typed Readable Stream')).toBeVisible({timeout:30000})
                  await expect.poll(()=>frame.locator('html').evaluate(()=>Object.keys(document).some(key=>key.startsWith('__reactContainer$'))),{timeout:30000}).toBe(true)
                  await verifyVisibleStream(frame,'Get 10 random numbers (ReadableStream)',0)
                  await verifyVisibleStream(frame,'Get 10 random numbers (Async Generator Function)',1)
                }else{
                  const solid=realKind==='solid'
                  const button=frame.getByRole('button',{name:solid?'Clicks: 0':'Add 1 to 0?'})
                  await expect(button).toBeVisible({timeout:30000})
                  await button.click()
                  await expect(frame.getByRole('button',{name:solid?'Clicks: 1':'Add 1 to 1?'})).toBeVisible({timeout:10000})
                }
              }catch(error){await reportProductionPreviewFailure(page,error);throw error}
              },async()=>{
                try{await page.evaluate(async()=>{window.nativeProductionPreview?.close();await window.nativeProductionDev?.dispose()})}
                catch(error){await reportProductionPreviewFailure(page,error,'shutdown');throw error}
              })
            }
          }
          continue
        }
          const full=await page.evaluate(async({realCounter,exactLock,realKind,realExample,entryMode,workerURL,scriptMode,runtimeSelection,trace,moduleTrace,browserModules,classicVM})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const lock=exactLock??await(await fetch('/start-fixture/browser-build-lock.json')).json()
            const files=realCounter??{
              '/app/package.json':'{"type":"module"}',
              '/app/vite.config.ts':"import {serverPort} from './dev-config.js';export default {server:{port:serverPort}}",
              '/app/dev-config.js':'export const serverPort=3000',
              '/app/index.html':'<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>',
              '/app/main.js':'import React from "react";document.body.dataset.react=React.version',
            }
            const dev=new NativeDevServer(files,{lock,entry:entryMode&&!scriptMode?'server.js':undefined,
              workerType:classicVM?'classic':'module',
              env:{...(moduleTrace?{NATIVE_MODULE_TRACE:'1'}:{}),...(browserModules?{NATIVE_BROWSER_MODULES:'1'}:{}),...(classicVM?{NATIVE_CLASSIC_VM:'1'}:{})},
              script:scriptMode?'dev':undefined,workerURL:runtimeSelection?'/missing-fallback.js':workerURL??window.nativeWorkerURL,
              ...(runtimeSelection?{runtimeCandidates:[
                {workerURL:'/missing-runtime.js',toolchain:{vite:'8.3.1',rolldown:'1.2.12'}},
                {workerURL:workerURL??window.nativeWorkerURL,toolchain:{vite:'8.3.1',rolldown:'1.2.11'}},
              ]}:{})})
            let keepOpen=false
            let phase='startup'
            if(trace)dev.worker.addEventListener('message',({data})=>{
              if(data?.type==='sandbox-install-stage'&&data.channel==='phase')console.log('NATIVE_EXAMPLE_TRACE '+JSON.stringify(data))
              if(moduleTrace&&data?.type==='native-dev-progress'&&/^module-(?:fetch|evaluate)-/.test(data.phase))console.log('NATIVE_EXAMPLE_TRACE '+JSON.stringify(data))
              if(moduleTrace&&data?.type==='native-dev-output')console.log('NATIVE_EXAMPLE_TRACE '+JSON.stringify({type:'process-output',stream:data.stream,text:data.text.slice(-8192)}))
            })
            const startedAt=performance.now()
            const traceState=()=>console.log('NATIVE_EXAMPLE_TRACE '+JSON.stringify({phase,elapsedMs:performance.now()-startedAt,progress:dev.progress.slice(-6),diagnostics:dev.diagnostics.slice(-4)}))
            const traceTimer=trace?setInterval(traceState,10000):undefined
            if(trace)traceState()
            try{
              const port=await dev.ready
              if(entryMode){
                phase='discover entry port'
                let ports=[]
                for(let attempt=0;attempt<100;attempt++){
                  ports=await dev.ports()
                  if(ports.includes(3000))break
                  await new Promise(resolve=>setTimeout(resolve,100))
                }
                if(!ports.includes(3000))return {ports,diagnostics:dev.diagnostics}
                phase='fetch entry document'
                const response=await dev.fetch(new Request('http://127.0.0.1:3000/'))
                window.nativeRealDev=dev
                keepOpen=true
                return {ports,status:response.status,poweredBy:response.headers.get('x-powered-by'),body:(await response.text()).slice(0,1600),diagnostics:dev.diagnostics}
              }
              phase='read installed package'
              const packageName=JSON.parse(new TextDecoder().decode(await dev.readFile(`/app/node_modules/${realKind==='solid'?'solid-js':'react'}/package.json`))).name
              phase='fetch initial module or document'
              const requestStartedAt=performance.now()
              const response=await dev.fetch(new Request(`http://127.0.0.1:${port}/${realExample==='react-router-ssr'?'src/entry-client.tsx':realCounter?'':'main.js'}`))
              phase='consume initial response'
              const code=await response.text()
              const document=new DOMParser().parseFromString(code,'text/html')
              const ssrText=realExample==='react-basic'?document.body.textContent?.includes('Welcome Home!!!'):realExample==='react-streaming'?document.body.textContent?.includes('Typed Readable Stream'):document.querySelector('button')?.textContent===(realKind==='solid'?'Clicks: 0':'Add 1 to 0?')
              if(realCounter&&realExample!=='react-router-ssr'){window.nativeRealDev=dev;keepOpen=true}
              return {packages:lock.packages.length,packageName,port,status:response.status,reactImport:code.includes('react'),ssrText,errorBody:response.ok?undefined:code.slice(0,1200),
                ...(!response.ok?{startupMs:requestStartedAt-startedAt,requestMs:performance.now()-requestStartedAt,
                  progress:dev.progress,diagnostics:dev.diagnostics,output:dev.events.filter(event=>event.type==='output').slice(-20)}:{})}
            }catch(error){
              console.error('NATIVE_EXAMPLE_PHASE_FAILURE',JSON.stringify({phase,error:String(error),requestDiagnostic:error?.diagnostic,progress:dev.progress,diagnostics:dev.diagnostics,output:dev.events.filter(event=>event.type==='output').slice(-20)}))
              return {error:String(error),phase,requestDiagnostic:error?.diagnostic,progress:dev.progress,diagnostics:dev.diagnostics}
            }finally{try{if(!keepOpen){
              try{await dev.dispose()}
              catch(error){console.error('NATIVE_EXAMPLE_PHASE_FAILURE',JSON.stringify({phase:'dispose',previousPhase:phase,error:String(error),progress:dev.progress,diagnostics:dev.diagnostics}));throw error}
            }}finally{if(traceTimer!==undefined)clearInterval(traceTimer)}}
          },{realCounter,exactLock,realKind,realExample,entryMode:process.env.NATIVE_REAL_ROUTER_ENTRY==='1',
            workerURL:process.env.NATIVE_PORTABLE_PATH==="1"?'/portable/runtime/engine.js':undefined,
            scriptMode:process.env.NATIVE_PROJECT_SCRIPT==='1',runtimeSelection:process.env.NATIVE_RUNTIME_SELECTION==='1',trace:process.env.NATIVE_EXAMPLE_TRACE==='1',moduleTrace:process.env.NATIVE_EXAMPLE_MODULE_TRACE==='1',browserModules:process.env.NATIVE_BROWSER_MODULES==='1',classicVM:process.env.NATIVE_CLASSIC_VM==='1'})
          if(process.env.NATIVE_REAL_TYPECHECK==='1'){
            assert.equal(full.error,undefined,`${browserType.name()} dev startup: ${JSON.stringify(full)}`)
            const result=await page.evaluate(async()=>{
              try{return await window.nativeRealDev.typecheck()}
              catch(error){return {error:String(error),progress:window.nativeRealDev.progress}}
              finally{await window.nativeRealDev.dispose()}
            })
            assert.equal(result.error,undefined,`${browserType.name()} TypeScript execution: ${JSON.stringify(result)}`)
            assert.deepEqual(result.diagnostics,[],`${browserType.name()} TypeScript diagnostics`)
            continue
          }
          if(process.env.NATIVE_REAL_BUILD==='1'){
            assert.equal(full.error,undefined,`${browserType.name()} dev startup: ${JSON.stringify(full)}`)
            const productionEntry=realExample==='react-basic'?'/app/.output/server/index.mjs':realExample==='react-router-ssr'?'/app/dist/server/entry-server.js':'/app/dist/server/server.js'
            const productionPreview=process.env.NATIVE_PRODUCTION_PREVIEW==='1'&&process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1'&&['react-basic','react-streaming','solid-counter','react-counter','react-router-ssr'].includes(realExample)
            const staticOnly=process.env.NATIVE_ROUTER_STATIC_ONLY==='1'&&realExample==='react-router-ssr'
            const build=await page.evaluate(async({entry,execute,ssr,preview,previewOrigin,staticOnly,scriptBuild,terminalBuild,browserModules,classicVM})=>{
              try{
                let files
                if(terminalBuild){
                  const command=await window.nativeRealDev.terminalCommand('pnpm run build','/app')
                  if(command.exitCode!==0)throw Error(`Declared build CLI failed: ${JSON.stringify(command)}`)
                  files=Object.keys(await window.nativeRealDev.snapshot()).filter(path=>path.startsWith('/app/dist/')||path.startsWith('/app/.output/'))
                  console.log('DECLARED_BUILD_CLI',JSON.stringify({exitCode:command.exitCode,stdout:command.stdout,stderr:command.stderr,outputs:files.length}))
                }else files=scriptBuild?(await window.nativeRealDev.runBuildScript()).outputFiles:await window.nativeRealDev.build()
                if(ssr&&!scriptBuild&&!terminalBuild)files.push(...await window.nativeRealDev.build({ssr:true}))
                let entryBytes=0
                try{entryBytes=(await window.nativeRealDev.readFile(entry)).length}catch{}
                if(!execute)return {files,entryBytes}
                const snapshot=await window.nativeRealDev.snapshot()
                await window.nativeRealDev.dispose()
                if(staticOnly)snapshot['/app/__native_static_probe__.mjs']=new TextEncoder().encode(`import express from 'express';const app=express();app.use(express.static('./dist/client'));app.listen(3000)`)
                const {NativeDevServer}=await import('/native-sdk/index.js')
                const production=new NativeDevServer(snapshot,{workerURL:window.nativeWorkerURL,workerType:classicVM?'classic':'module',
                  entry:staticOnly?'__native_static_probe__.mjs':entry.endsWith('/dist/server/entry-server.js')?'server.js':entry,
                  env:{NODE_ENV:'production',...(browserModules?{NATIVE_BROWSER_MODULES:'1'}:{}),...(classicVM?{NATIVE_CLASSIC_VM:'1'}:{})},
                  serveFetchEntry:entry.endsWith('/dist/server/server.js'),
                  staticRoot:entry.endsWith('/dist/server/server.js')?'/app/dist/client':undefined})
                let keepProduction=false
                try{
                  await production.ready
                  let ports=[]
                  for(let attempt=0;attempt<100;attempt++){
                    ports=await production.ports()
                    if(ports.length)break
                    await new Promise(resolve=>setTimeout(resolve,100))
                  }
                  if(!ports.length)return {files,entryBytes,production:{ports,diagnostics:production.diagnostics}}
                  try{
                    let staticAsset
                    let binaryAsset
                    if(entry.endsWith('/.output/server/index.mjs')){
                      const result=await production.fetch(new Request(`http://127.0.0.1:${ports[0]}/favicon-32x32.png`))
                      const bytes=new Uint8Array(await result.arrayBuffer())
                      binaryAsset={status:result.status,png:bytes.length>8&&[137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte),bytes:bytes.length}
                    }
                    if(entry.endsWith('/dist/server/entry-server.js')){
                      try{
                        const result=await production.fetch(new Request(`http://127.0.0.1:${ports[0]}/static/entry-client.js`,{signal:AbortSignal.timeout(10000)}))
                        staticAsset={status:result.status,type:result.headers.get('content-type'),bytes:(await result.arrayBuffer()).byteLength}
                      }catch(error){staticAsset={error:String(error)}}
                    }
                    if(staticOnly)return {files,entryBytes,production:{ports,staticAsset,diagnostics:production.diagnostics}}
                    if(entry.endsWith('/dist/server/server.js')){
                      const asset=files.find(path=>path.startsWith('/app/dist/client/')&&path.endsWith('.js'))
                      if(asset){
                        const result=await production.fetch(new Request(`http://127.0.0.1:${ports[0]}${asset.slice('/app/dist/client'.length)}`))
                        staticAsset={path:asset,status:result.status,type:result.headers.get('content-type'),bytes:(await result.arrayBuffer()).byteLength}
                      }
                    }
                    const response=await production.fetch(new Request(`http://127.0.0.1:${ports[0]}/`))
                    const body=await response.text()
                    if(preview){
                      const {URLPreview}=await import('/native-sdk/index.js')
                      const target=document.createElement('div')
                      target.id='native-production-preview'
                      document.body.append(target)
                      window.nativeProductionPreview=await URLPreview.mount(target,{origin:previewOrigin,
                        server:production.previewServer(ports[0]),
                        scriptOrigins:entry.endsWith('/dist/server/entry-server.js')?['https://unpkg.com']:undefined,
                        connectOrigins:entry.endsWith('/dist/server/entry-server.js')?['https://jsonplaceholder.typicode.com']:undefined})
                      window.nativeProductionDev=production
                      keepProduction=true
                    }
                    return {files,entryBytes,production:{ports,staticAsset,binaryAsset,status:response.status,expectedText:body.includes('Welcome Home!!!'),solidText:body.includes('Hello world!'),body:body.slice(0,1000),diagnostics:production.diagnostics}}
                  }catch(error){return {files,entryBytes,production:{ports,error:String(error),diagnostics:production.diagnostics,progress:production.progress}}}
                }finally{if(!keepProduction)await production.dispose()}
              }
              catch(error){return {error:String(error),typecheckDiagnostics:error.diagnostics,diagnostics:window.nativeRealDev.diagnostics,progress:window.nativeRealDev.progress}}
              finally{await window.nativeRealDev.dispose()}
            },{entry:productionEntry,execute:process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1',ssr:realExample==='react-router-ssr'&&process.env.NATIVE_EXPECT_PRODUCTION_ENTRY==='1',preview:productionPreview,previewOrigin,staticOnly,scriptBuild:process.env.NATIVE_REAL_BUILD_SCRIPT==='1',terminalBuild:process.env.NATIVE_REAL_BUILD_CLI==='1',browserModules:process.env.NATIVE_BROWSER_MODULES==='1',classicVM:process.env.NATIVE_CLASSIC_VM==='1'})
            assert.equal(build.error,undefined,`${browserType.name()} Vite build: ${JSON.stringify(build)}`)
            if(staticOnly){assert.ok(build.production?.staticAsset?.status===200,`${browserType.name()} Express static file: ${JSON.stringify(build.production)}`);continue}
            assert.ok(build.files.some(path=>path.startsWith('/app/')&&/\.(?:js|mjs)$/.test(path)),`${browserType.name()} build produced no script output: ${JSON.stringify(build.files.slice(0,12))}`)
            assert.ok(build.files.some(path=>path.includes('/assets/')),`${browserType.name()} build produced no client assets: ${JSON.stringify(build.files.slice(0,12))}`)
            if(process.env.NATIVE_EXPECT_PRODUCTION_ENTRY==='1')assert.ok(build.entryBytes>0,`${browserType.name()} missing production entry ${productionEntry}: ${JSON.stringify(build.files.filter(path=>path.startsWith('/app/.output/server/')||path.startsWith('/app/dist/server/')).slice(0,25))}`)
            if(process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1')assert.equal(build.production?.status,200,`${browserType.name()} production server: ${JSON.stringify(build.production)}`)
            if(process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1'&&realExample==='react-basic')assert.equal(build.production.expectedText,true,`${browserType.name()} production page content: ${JSON.stringify(build.production)}`)
            if(process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1'&&realExample==='react-basic')assert.ok(build.production.binaryAsset?.status===200&&build.production.binaryAsset.png,`${browserType.name()} production PNG asset: ${JSON.stringify(build.production)}`)
            if(process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1'&&realExample==='react-router-ssr')assert.ok(build.production.body.includes('Welcome Home!'),`${browserType.name()} Router production page content: ${JSON.stringify(build.production)}`)
            if(process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1'&&realExample==='react-router-ssr')assert.ok(build.production.staticAsset?.status===200&&build.production.staticAsset.bytes>0,`${browserType.name()} Router production client asset: ${JSON.stringify(build.production)}`)
            if(process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1'&&realExample==='react-streaming')assert.ok(build.production.body.includes('Typed Readable Stream'),`${browserType.name()} streaming production page content: ${JSON.stringify(build.production)}`)
            if(process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1'&&realExample==='solid-counter')assert.equal(build.production.solidText,true,`${browserType.name()} Solid production page content: ${JSON.stringify(build.production)}`)
            if(process.env.NATIVE_EXECUTE_PRODUCTION_ENTRY==='1'&&['react-streaming','solid-counter','react-counter'].includes(realExample))assert.ok(build.production.staticAsset?.status===200&&build.production.staticAsset.bytes>0,`${browserType.name()} production client asset: ${JSON.stringify(build.production)}`)
            if(productionPreview){
              await runWithCleanup(async()=>{try{
                const frame=page.frameLocator('#native-production-preview iframe')
                await expect.poll(()=>page.evaluate(()=>window.nativeProductionPreview.requests.some(request=>request.pathname.endsWith('.js')&&request.status===200)),{timeout:30000}).toBe(true)
                if(realExample==='react-router-ssr'){
                  await expect(frame.getByText('Welcome Home!')).toBeVisible({timeout:30000})
                  await expect.poll(()=>frame.locator('html').evaluate(()=>Object.keys(document).some(key=>key.startsWith('__reactContainer$'))),{timeout:30000}).toBe(true)
                  await frame.getByRole('link',{name:'Posts'}).click()
                  await expect(frame.getByText('Select a post.')).toBeVisible({timeout:30000})
                }else if(realExample==='react-basic'){
                  await expect(frame.getByText('Welcome Home!!!')).toBeVisible({timeout:30000})
                  await expect.poll(()=>frame.locator('html').evaluate(()=>Object.keys(document).some(key=>key.startsWith('__reactContainer$'))),{timeout:30000}).toBe(true)
                  await frame.getByRole('link',{name:'Deferred'}).click()
                  await expect(frame.getByText('Hello deferred!')).toBeVisible({timeout:30000})
                  await expect(frame.getByText('John Doe')).toBeVisible({timeout:30000})
                  await expect(frame.getByText('Tanner Linsley')).toBeVisible({timeout:30000})
                }else if(realExample==='react-streaming'){
                  await expect(frame.getByText('Typed Readable Stream')).toBeVisible({timeout:30000})
                  await expect.poll(()=>frame.locator('html').evaluate(()=>Object.keys(document).some(key=>key.startsWith('__reactContainer$'))),{timeout:30000}).toBe(true)
                  await verifyVisibleStream(frame,'Get 10 random numbers (ReadableStream)',0)
                  await verifyVisibleStream(frame,'Get 10 random numbers (Async Generator Function)',1)
                }else if(realExample==='solid-counter'){
                  const button=frame.getByRole('button',{name:'Clicks: 0'})
                  await expect(button).toBeVisible({timeout:30000})
                  await button.click()
                  await expect(frame.getByRole('button',{name:'Clicks: 1'})).toBeVisible({timeout:10000})
                }else{
                  const button=frame.getByRole('button',{name:'Add 1 to 0?'})
                  await expect(button).toBeVisible({timeout:30000})
                  await button.click()
                  await expect(frame.getByRole('button',{name:'Add 1 to 1?'})).toBeVisible({timeout:10000})
                  const count=await page.evaluate(async()=>new TextDecoder().decode(await window.nativeProductionDev.readFile('/app/count.txt')))
                  assert.equal(count,'1')
                }
              }catch(error){await reportProductionPreviewFailure(page,error);throw error}
              },async()=>{
                try{await page.evaluate(()=>{window.nativeProductionPreview?.close();window.nativeProductionDev?.close()})}
                catch(error){await reportProductionPreviewFailure(page,error,'shutdown');throw error}
              })
            }
            continue
          }
          if(process.env.NATIVE_REAL_ROUTER_ENTRY==='1'){
            assert.equal(full.error,undefined,`${browserType.name()} router entry: ${JSON.stringify(full)}`)
            assert.ok(full.ports?.length>0,`${browserType.name()} router entry did not listen: ${JSON.stringify(full)}`)
            assert.equal(full.status,200,`${browserType.name()} router response: ${JSON.stringify(full)}`)
            assert.equal(full.poweredBy,'Express')
            assert.ok(full.body.includes('Welcome Home!'))
            try{
              await page.evaluate(async({previewOrigin,hmrDelayMs})=>{
                const {URLPreview}=await import('/native-sdk/index.js')
                const target=document.createElement('div')
                target.id='real-preview'
                document.body.append(target)
                const dev=window.nativeRealDev
                window.nativeRouterSockets=[]
                window.nativeRealPreview=await URLPreview.mount(target,{origin:previewOrigin,
                  scriptOrigins:['https://unpkg.com'],connectOrigins:['https://jsonplaceholder.typicode.com'],
                  server:dev.previewServer(3000),
                  connectWebSocket:async(url,protocols)=>{
                    const record={url,protocols,connected:false}
                    window.nativeRouterSockets.push(record)
                    if(hmrDelayMs)await new Promise(resolve=>setTimeout(resolve,hmrDelayMs))
                    return dev.connectWebSocket(previewOrigin,url,protocols).then(socket=>{
                      record.connected=true
                      record.messages=[]
                      const next=socket.next.bind(socket)
                      socket.next=async()=>{
                        const event=await next()
                        if(event?.type==='text'){
                          try{
                            const message=JSON.parse(event.data)
                            record.messages.push({type:message.type,updates:message.updates?.map(update=>({path:update.path,acceptedPath:update.acceptedPath,type:update.type}))})
                            if(record.messages.length>50)record.messages.shift()
                          }catch{/* Non-JSON messages remain available to the preview. */}
                        }
                        return event
                      }
                      return socket
                    },error=>{record.error=String(error);throw error})
                  }})
              },{previewOrigin,hmrDelayMs:Number(process.env.NATIVE_ROUTER_HMR_DELAY_MS??0)})
              const frame=page.frameLocator('#real-preview iframe')
              await expect(frame.getByText('Welcome Home!')).toBeVisible({timeout:30000})
              await expect.poll(()=>page.evaluate(()=>window.nativeRealPreview.requests
                .filter(request=>['/src/entry-client.tsx','/src/router.tsx','/node_modules/react-dom/client.js'].includes(request.pathname))
                .map(request=>[request.pathname,request.status])),{timeout:30000})
                .toContainEqual(['/node_modules/react-dom/client.js',200])
              let preEditState
              await expect.poll(()=>frame.locator('html').evaluate(()=>{
                const key=Object.keys(document).find(key=>key.startsWith('__reactContainer$'))
                const fiber=key&&document[key]
                return {allocated:!!key,posts:document.querySelectorAll('a[href="/posts"]').length,isDehydrated:fiber?.stateNode?.current?.memoizedState?.isDehydrated}
              }).then(state=>{preEditState=state;return state.allocated&&state.isDehydrated===false&&state.posts===1}),{timeout:30000}).toBe(true)
              const indexPath='/app/src/routes/index.tsx'
              const originalIndex=new TextDecoder().decode(realCounter[indexPath])
              const editedIndex=originalIndex.replace('Welcome Home!','Native Home!')
              assert.notEqual(editedIndex,originalIndex)
              const socketsBeforeEdit=await page.evaluate(()=>window.nativeRouterSockets)
              if(process.env.NATIVE_ROUTER_HMR_DELAY_MS)console.log('router HMR sockets before edit',JSON.stringify(socketsBeforeEdit))
              await page.evaluate(async({path,source})=>window.nativeRealDev.writeFile(path,source),{path:indexPath,source:editedIndex})
              if(process.env.NATIVE_EXAMPLE_MODULE_TRACE==='1')console.log('ROUTER_PRE_EDIT_STATE',JSON.stringify(preEditState))
              try{await expect(frame.getByText('Native Home!')).toBeVisible({timeout:30000})}
              catch(error){
                const state=await page.evaluate(()=>({sockets:window.nativeRouterSockets,
                  requests:window.nativeRealPreview.requests.slice(-25),diagnostics:window.nativeRealPreview.diagnostics.slice(-10),
                  runtimeDiagnostics:window.nativeRealDev.diagnostics.slice(-10)}))
                throw Error(`Router live edit did not reach preview: ${JSON.stringify({socketsBeforeEdit,state,body:await frame.locator('body').textContent().catch(()=>null)})}`,{cause:error})
              }
              console.log('ROUTER_HMR_MESSAGES',JSON.stringify(await page.evaluate(()=>window.nativeRouterSockets.map(socket=>({connected:socket.connected,messages:socket.messages})))))
              const snapshot=await page.evaluate(async()=>window.nativeRouterSnapshot=await window.nativeRealDev.snapshot())
              assert.equal(new TextDecoder().decode(snapshot[indexPath]),editedIndex)
              if(process.env.NATIVE_REAL_CHECKPOINT==='1')
                await page.evaluate(()=>window.nativeRealDev.saveCheckpoint('native-router-edited-test'))
              try{await frame.getByRole('link',{name:'Posts'}).click()}
              catch(error){
                const dom=await frame.locator('html').evaluate(html=>({
                  links:[...html.querySelectorAll('a[href="/posts"]')].map(link=>({html:link.outerHTML,parent:link.parentElement?.outerHTML.slice(0,4000)})),
                  bodies:html.querySelectorAll('body').length,
                  scripts:[...html.querySelectorAll('script')].map(script=>({src:script.src,type:script.type})),
                })).catch(()=>null)
                let settled=false
                try{await expect.poll(()=>frame.getByRole('link',{name:'Posts'}).count(),{timeout:2000,intervals:[50,100,250]}).toBe(1);settled=true}catch{}
                const afterCount=await frame.getByRole('link',{name:'Posts'}).count().catch(()=>null)
                throw Error(`Router Posts navigation failed: ${JSON.stringify({dom,settled,afterCount})}`,{cause:error})
              }
              await expect(frame.getByText('Select a post.')).toBeVisible({timeout:30000})
            }finally{await page.evaluate(async()=>{window.nativeRealPreview?.close();await window.nativeRealDev?.dispose()})}
            const resumed=await page.evaluate(async persisted=>{
              const {NativeDevServer}=await import('/native-sdk/index.js')
              const dev=persisted
                ?await NativeDevServer.restoreCheckpoint('native-router-edited-test',{workerURL:window.nativeWorkerURL,entry:'server.js'})
                :new NativeDevServer(window.nativeRouterSnapshot,{workerURL:window.nativeWorkerURL,entry:'server.js'})
              try{
                await dev.ready
                let ports=[]
                for(let attempt=0;attempt<100;attempt++){
                  ports=await dev.ports()
                  if(ports.includes(3000))break
                  await new Promise(resolve=>setTimeout(resolve,100))
                }
                if(!ports.includes(3000))return {ports,diagnostics:dev.diagnostics,progress:dev.progress}
                const response=await dev.fetch(new Request('http://127.0.0.1:3000/'))
                return {status:response.status,body:(await response.text()).slice(0,1600),ports,diagnostics:dev.diagnostics,
                  restoredWithoutInstall:!dev.progress.some(item=>item.phase==='dependencies-install-started')}
              }catch(error){return {error:String(error),diagnostics:dev.diagnostics,progress:dev.progress}}
              finally{await dev.dispose()}
            },process.env.NATIVE_REAL_CHECKPOINT==='1')
            assert.equal(resumed.status,200,`${browserType.name()} router resume: ${JSON.stringify(resumed)}`)
            assert.ok(resumed.body.includes('Native Home!'))
            if(process.env.NATIVE_REAL_CHECKPOINT==='1')assert.equal(resumed.restoredWithoutInstall,true)
            continue
          }
          if(realCounter&&process.env.NATIVE_CONFIG_BUNDLE==='1'&&browserType===chromium){
            const bundled=await page.evaluate(async({files,lock})=>{
              const {NativeKernel}=await import('/src/native/kernel.ts')
              const kernel=new NativeKernel()
              try{
                await kernel.initialize(files)
                await kernel.installLocked(lock)
                await kernel.loadEntry('/app/vite.config.ts')
                return {loaded:true}
              }catch(error){return {loaded:false,error:String(error)}}
              finally{kernel.close()}
            },{files:realCounter,lock:exactLock})
            console.log('real counter native bundle diagnostic',browserType.name(),bundled)
          }
          if(realExample==='react-router-ssr'){
            assert.equal(full.error,undefined,`${browserType.name()} router config: ${JSON.stringify(full)}`)
            assert.equal(full.status,200)
            assert.equal(full.reactImport,true)
            continue
          }
          if(realCounter){
            if(full.status!==200)console.log('real example diagnostic',browserType.name(),full)
            assert.equal(full.error,undefined,`${browserType.name()} real counter: ${JSON.stringify(full)}`)
            assert.equal(full.status,200)
            assert.equal(full.ssrText,true)
            if(realKind==='react'){
            const clientModule=await page.evaluate(async port=>{
              try{
                const response=await window.nativeRealDev.fetch(new Request(`http://127.0.0.1:${port}/node_modules/@tanstack/react-router/dist/esm/index.js`))
                return {status:response.status,body:(await response.text()).slice(0,1200)}
              }catch(error){return {error:String(error),stack:error?.stack}}
            },full.port)
            assert.equal(clientModule.error,undefined)
            assert.equal(clientModule.status,200)
            }
            try{
              await page.evaluate(async previewOrigin=>{
                const {URLPreview}=await import('/native-sdk/index.js')
                const target=document.createElement('div')
                target.id='real-preview'
                document.body.append(target)
                const dev=window.nativeRealDev
                window.nativeRealPreview=await URLPreview.mount(target,{
                  origin:previewOrigin,
                  server:{fetch:async request=>{try{return await dev.fetch(request)}catch(error){console.info('real-preview-fetch-error',String(error),error?.stack);throw error}}},
                  connectWebSocket:(url,protocols)=>dev.connectWebSocket(previewOrigin,url,protocols),
                })
              },previewOrigin)
              const realFrame=page.frameLocator('#real-preview iframe')
              if(realExample==='react-basic'||realExample==='react-streaming'){
                await expect(realFrame.getByText(realExample==='react-basic'?'Welcome Home!!!':'Typed Readable Stream')).toBeVisible({timeout:30000})
                if(realExample==='react-basic'){
                const favicon=await page.evaluate(async port=>{
                  const response=await window.nativeRealDev.fetch(new Request(`http://127.0.0.1:${port}/favicon-32x32.png`))
                  return {status:response.status,type:response.headers.get('content-type'),size:(await response.arrayBuffer()).byteLength}
                },full.port)
                assert.equal(favicon.status,200)
                assert.ok(favicon.size>0)
                const restored=await page.evaluate(async workerURL=>{
                  const {NativeDevServer}=await import('/native-sdk/index.js')
                  const snapshot=await window.nativeRealDev.snapshot()
                  const dev=new NativeDevServer(snapshot,{workerURL:workerURL??window.nativeWorkerURL})
                  try{
                    const port=await dev.ready
                    const response=await dev.fetch(new Request(`http://127.0.0.1:${port}/`))
                    return {status:response.status,home:(await response.text()).includes('Welcome Home!!!'),
                      packageAvailable:JSON.parse(new TextDecoder().decode(await dev.readFile('/app/node_modules/react/package.json'))).name==='react'}
                  }finally{await dev.dispose()}
                },process.env.NATIVE_PORTABLE_PATH==='1'?'/portable/runtime/engine.js':undefined)
                assert.deepEqual(restored,{status:200,home:true,packageAvailable:true})
                const editedPath='/app/src/routes/index.tsx'
                const originalSource=new TextDecoder().decode(realCounter[editedPath])
                const updatedSource=originalSource.replace('Welcome Home!!!','Parity Home!!!')
                assert.notEqual(updatedSource,originalSource)
                await page.evaluate(async({path,source})=>window.nativeRealDev.writeFile(path,source),{path:editedPath,source:updatedSource})
                await expect(realFrame.getByText('Parity Home!!!')).toBeVisible({timeout:30000})
                }else{
                  await realFrame.locator('button').filter({hasText:'TanStack Router v1'}).waitFor({state:'attached',timeout:30000})
                  for(const [button,index] of [['Get 10 random numbers (ReadableStream)',0],['Get 10 random numbers (Async Generator Function)',1]]){
                    await verifyVisibleStream(realFrame,button,index)
                  }
                  const editedPath='/app/src/routes/index.tsx'
                  const originalSource=new TextDecoder().decode(realCounter[editedPath])
                  const updatedSource=originalSource.replace('Typed Readable Stream','Parity Typed Stream')
                  assert.notEqual(updatedSource,originalSource)
                  await page.evaluate(async({path,source})=>window.nativeRealDev.writeFile(path,source),{path:editedPath,source:updatedSource})
                  await expect(realFrame.getByText('Parity Typed Stream')).toBeVisible({timeout:30000})
                }
              }else{
              const counterButton=realFrame.getByRole('button',{name:realKind==='solid'?'Clicks: 0':'Add 1 to 0?'})
              await expect(counterButton).toBeVisible({timeout:30000})
              await expect.poll(()=>page.evaluate(()=>window.nativeRealPreview.requests.some(request=>request.pathname==='/src/routes/index.tsx'&&request.status===200)),{timeout:30000}).toBe(true)
              if(realKind==='react')await realFrame.locator('button').filter({hasText:'TanStack Router v1'}).waitFor({state:'attached',timeout:30000})
              else await page.waitForTimeout(3000)
              await counterButton.click()
              await expect(realFrame.getByRole('button',{name:realKind==='solid'?'Clicks: 1':'Add 1 to 1?'})).toBeVisible({timeout:30000})
              const editedPath=realKind==='solid'?'/app/src/components/Counter.tsx':'/app/src/routes/index.tsx'
              const originalSource=new TextDecoder().decode(realCounter[editedPath])
              const updatedSource=originalSource.replace(realKind==='solid'?'Clicks:':'Add 1 to',realKind==='solid'?'Taps:':'Add one to')
              assert.notEqual(updatedSource,originalSource)
              await page.evaluate(async({path,source})=>window.nativeRealDev.writeFile(path,source),{path:editedPath,source:updatedSource})
              await expect(realFrame.getByRole('button',{name:realKind==='solid'?/^Taps: [01]$/:/^Add one to 1\?$/})).toBeVisible({timeout:30000})
              }
            }finally{
              await page.evaluate(async()=>{window.nativeRealPreview?.close();await window.nativeRealDev?.dispose()})
            }
          }else assert.deepEqual(full,{packages:JSON.parse(await readFile('public/start-fixture/browser-build-lock.json','utf8')).packages.length,packageName:'react',port:3000,status:200,reactImport:true,ssrText:false,errorBody:undefined})
        }
        await page.goto(server.resolvedUrls.local[0]+'native-dev-preview')
        await page.evaluate(url=>{window.nativeWorkerURL=url},process.env.NATIVE_PORTABLE_PATH==='1'?'/portable/runtime/engine.js':'/vite-runtime/engine.js')
        if(process.env.NATIVE_VITE8_BUNDLE_DIR)console.log('vite8 preview isolation',browserType.name(),await page.evaluate(()=>crossOriginIsolated))
        await page.evaluate(async previewOrigin=>{
          const [{NativeDevServer},{URLPreview}]=await Promise.all([
            import('/native-sdk/index.js'),import('/native-sdk/index.js'),
          ])
          const dev=new NativeDevServer({
            '/app/package.json':'{"type":"module"}',
            '/app/index.html':'<!doctype html><html><head><title>Native preview</title></head><body><button id="count">0</button><p id="message"></p><script type="module" src="/main.js"></script></body></html>',
            '/app/message.js':'export const message="first version"',
            '/app/main.js':`import {message} from './message.js';
              document.querySelector('#message').textContent=message;
              let count=0;document.querySelector('#count').onclick=()=>document.querySelector('#count').textContent=String(++count);
              if(import.meta.hot)import.meta.hot.accept('./message.js',next=>document.querySelector('#message').textContent=next.message);`,
          },{workerURL:window.nativeWorkerURL})
          window.nativeDev=dev
          window.nativePreview=await URLPreview.mount(document.querySelector('#preview'),{
            origin:previewOrigin,server:{fetch:async request=>{
              try{return await dev.fetch(request)}catch(error){console.info('native-vite-preview-fetch-error',String(error),error?.stack);throw error}
            }},
            connectWebSocket:(url,protocols)=>dev.connectWebSocket(previewOrigin,url,protocols),
          })
        },previewOrigin)
        const frame=page.frameLocator('#preview iframe')
        await expect(frame.locator('#message')).toHaveText('first version',{timeout:15000})
        await frame.locator('#count').click()
        await expect(frame.locator('#count')).toHaveText('1')
        await page.evaluate(()=>window.nativeDev.writeFile('/app/message.js','export const message="second version"'))
        await expect(frame.locator('#message')).toHaveText('second version',{timeout:15000})
        await expect(frame.locator('#count')).toHaveText('1')
        await page.evaluate(()=>{window.nativePreview.close();window.nativeDev.close()})
        assert.deepEqual(pageErrors,[])
      }finally{await browser.close()}
    }
    if(process.env.NATIVE_PERSISTENT_CHECKPOINT==='1'){
      const persistentReal=process.env.NATIVE_PERSISTENT_REAL_EXAMPLE==='1'
      if(persistentReal&&!realCounter)throw Error('Persistent real-example checkpoint requires a selected real example')
      const persistentLock=persistentReal?await readFile(resolve(realFixture,'package-lock.json'),'utf8'):undefined
      for(const browserType of [chromium,firefox,webkit].filter(browser=>!process.env.NATIVE_TEST_BROWSER||browser.name()===process.env.NATIVE_TEST_BROWSER)){
        const profile=await mkdtemp(join(tmpdir(),`native-checkpoint-profile-${browserType.name()}-`))
        const url=server.resolvedUrls.local[0]+'native-dev-preview'
        const workerURL=process.env.NATIVE_PORTABLE_PATH==='1'?'/portable/runtime/engine.js':'/vite-runtime/engine.js'
        const first=await browserType.launchPersistentContext(profile,{headless:true})
        try{
          const page=await first.newPage()
          await page.goto(url)
          await page.evaluate(value=>{window.nativeWorkerURL=value},workerURL)
          const saved=await page.evaluate(async({real,files,lockText})=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const mounted=real?Object.fromEntries(Object.entries({...files,'/app/package-lock.json':lockText})
              .map(([path,bytes])=>['/project'+path.slice('/app'.length),bytes])):{
              '/project/package.json':'{"type":"module"}',
              '/project/index.html':'<p>persisted before restart</p>',
              '/project/binary.dat':new Uint8Array([0,1,128,255]),
            }
            const dev=new NativeDevServer(mounted,real
              ?{workerURL:window.nativeWorkerURL,workspaceRoot:'/project',installCommand:'pnpm install',startCommand:'pnpm run dev'}
              :{workerURL:window.nativeWorkerURL,workspaceRoot:'/project'})
            try{
              await dev.ready
              if(real){
                const path='/project/src/routes/index.tsx'
                const original=new TextDecoder().decode(await dev.readFile(path))
                await dev.writeFile(path,original+'\n// persisted native checkpoint marker\n')
              }else await dev.writeFile('/project/index.html','<p>persisted after edit</p>')
              return await dev.saveCheckpoint('browser-restart-checkpoint')
            }finally{await dev.dispose()}
          },{real:persistentReal,files:realCounter,lockText:persistentLock})
          assert.equal(saved.key,'browser-restart-checkpoint')
        }finally{await first.close()}
        const second=await browserType.launchPersistentContext(profile,{headless:true})
        try{
          const page=await second.newPage()
          await page.goto(url)
          await page.evaluate(value=>{window.nativeWorkerURL=value},workerURL)
          const restored=await page.evaluate(async real=>{
            const {NativeDevServer}=await import('/native-sdk/index.js')
            const dev=await NativeDevServer.restoreCheckpoint('browser-restart-checkpoint',
              {workerURL:window.nativeWorkerURL,workspaceRoot:'/project',...(real?{startCommand:'pnpm run dev'}:{})})
            try{
              const port=await dev.ready
              const binary=real?undefined:[...await dev.readFile('/project/binary.dat')]
              const edited=real?new TextDecoder().decode(await dev.readFile('/project/src/routes/index.tsx'))
                :undefined
              const response=await dev.fetch(new Request(`http://127.0.0.1:${port}/`))
              const body=await response.text()
              return {binary,status:response.status,edited:real
                ?edited?.includes('persisted native checkpoint marker')
                :body.includes('persisted after edit'),
                ...(real?{renderedCounter:body.includes('Add 1 to')}:{}),
                reinstalled:dev.progress.some(item=>item.phase==='dependencies-install-started')}
            }finally{await dev.dispose()}
          },persistentReal)
          assert.deepEqual(restored,{binary:persistentReal?undefined:[0,1,128,255],status:200,edited:true,
            ...(persistentReal?{renderedCounter:true}:{}),reinstalled:false},browserType.name())
        }finally{await second.close()}
      }
    }
  }finally{await server.close();await new Promise(resolve=>previewHost.close(resolve))}
})
