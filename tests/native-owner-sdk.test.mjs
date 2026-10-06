import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile,mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {chromium,firefox,webkit} from '@playwright/test'
import {recordAcceptanceFailure,assertAcceptancePassed} from '../scripts/acceptance-failures.mjs'
import {nativeInstallTraceResponse} from '../scripts/native-install-stage-observation.mjs'
import {readPinnedNativeExamples} from '../scripts/native-example-sources.mjs'
import {sdkBrowserAssets} from '../scripts/sdk-browser-assets.mjs'
import {installNativeStreamObservation} from '../scripts/native-stream-observation.mjs'
import {observeNativeOwnerStartup} from '../scripts/native-owner-startup-observation.mjs'
import {writeNativeOwnerTimings} from '../scripts/native-owner-timings.mjs'
import {waitForPinnedStartClient} from '../scripts/native-start-example-readiness.mjs'
import {installFetchConsumptionObservation} from '../scripts/native-fetch-consumption-observation.mjs'
import {installNativeWorkerIOObservation} from '../scripts/native-worker-io-observation.mjs'
import {installNativePreviewInteractionObservation} from '../scripts/native-preview-interaction-observation.mjs'
import {installNativePreviewClickListenerObservation} from '../scripts/native-preview-click-listener-observation.mjs'

const sdkRoot=process.env.NATIVE_SDK_BUNDLE_DIR
const deployment=process.env.NATIVE_DEPLOYMENT_DIR
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)))
const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))

test('packaged native SDK runs a project in a separate-origin owner frame',{
  skip:!sdkRoot||!deployment?'Set NATIVE_SDK_BUNDLE_DIR and NATIVE_DEPLOYMENT_DIR to run packaged owner-origin test':false,
},async()=>{
  const nativeOnly=!JSON.parse(await readFile(join(sdkRoot,'api-contract.json'),'utf8')).entrypoints['.'].exports.some(item=>item.name==='WorkerKernel')
  const sdkAssets=sdkBrowserAssets(sdkRoot)
  const runtimeCatalog=process.env.NATIVE_OWNER_RUNTIME_CATALOG==='1'
    ?(await import(pathToFileURL(join(sdkRoot,'assets.mjs')).href)).readNativeRuntimeCandidates():undefined
  const workerPath=runtimeCatalog?.[0]?.workerURL??'/runtime/native/engine.js'
  const tracedWorkerPaths=new Set([workerPath,...(runtimeCatalog??[]).map(runtime=>runtime.workerURL)])
  const routerRoot=process.env.TANSTACK_ROUTER_SOURCE??resolve('../router')
  const pinnedExamples=process.env.NATIVE_OWNER_PINNED_EXAMPLES==='1'?readPinnedNativeExamples().examples:undefined
  if(pinnedExamples)assert.notEqual(process.env.NATIVE_OWNER_LOCKLESS,'1','Pinned example gate requires its original lockfiles')
  const examples=await Promise.all([
    {name:'TanStack Start counter',kind:'react',path:'start-counter',fixture:'native-real-counter',initial:'Add 1 to 0?',
      before:'Add 1 to',after:'Add one to',clicked:'Add 1 to 1?',updated:'Add one to',editPath:'src/routes/index.tsx'},
    {name:'TanStack Start basic',kind:'react',path:'start-basic',fixture:'native-real-start-basic',initial:'Welcome Home!!!',
      before:'Welcome Home!!!',after:'Parity Home!!!',updated:'Parity Home!!!',editPath:'src/routes/index.tsx'},
    {name:'TanStack Start streaming',kind:'react',path:'start-streaming-data-from-server-functions',
      fixture:'native-real-start-streaming',initial:'Typed Readable Stream',before:'Typed Readable Stream',
      after:'Parity Typed Stream',updated:'Parity Typed Stream',editPath:'src/routes/index.tsx',streaming:true},
    {name:'TanStack Router file-based SSR',kind:'react',path:'basic-ssr-file-based',
      fixture:'native-real-router-ssr',initial:'Welcome Home!',before:'Welcome Home!',
      after:'Parity Home!',updated:'Parity Home!',editPath:'src/routes/index.tsx',previewPort:3000},
    {name:'Solid Start counter',kind:'solid',path:'start-counter',fixture:'native-real-solid-counter',initial:'Clicks: 0',
      before:'Clicks:',after:'Taps:',clicked:'Clicks: 1',updated:'Taps:',editPath:'src/components/Counter.tsx'},
    ...(process.env.NATIVE_OWNER_SOLID_BREADTH==='1'?[{
      name:'Solid Start basic',kind:'solid',path:'start-basic',initial:'Welcome Home!!!',
      before:'Welcome Home!!!',after:'Parity Home!!!',updated:'Parity Home!!!',editPath:'src/routes/index.tsx',
    },{
      name:'Solid Start streaming',kind:'solid',path:'start-streaming-data-from-server-functions',
      initial:'Typed Readable Stream',before:'Typed Readable Stream',after:'Parity Typed Stream',
      updated:'Parity Typed Stream',editPath:'src/routes/index.tsx',streaming:true,
    },{
      name:'Solid Start query',kind:'solid',path:'start-basic-solid-query',
      initial:'Welcome Home!!!',before:'Welcome Home!!!',after:'Parity Home!!!',
      updated:'Parity Home!!!',editPath:'src/routes/index.tsx',
      productionExpected:['Hello deferred from the server!','Count: 0'],
    },{
      name:'Solid Start Tailwind',kind:'solid',path:'start-tailwind-v4',
      initial:'Welcome Home!!!',before:'Welcome Home!!!',after:'Parity Home!!!',
      updated:'Parity Home!!!',editPath:'src/routes/index.tsx',tailwind:true,
    }]:[]),
  ].map(async example=>{
    const examplePath=`examples/${example.kind}/${example.path}`
    const pinned=pinnedExamples?.get(`${example.kind}/${example.path}`)
    if(pinnedExamples)assert.ok(pinned,'Example is absent from pinned source inputs: '+examplePath)
    const paths=pinned?[]:execFileSync('git',['-C',routerRoot,'ls-files',examplePath],{encoding:'utf8'}).trim().split('\n')
    const files=pinned?.files??Object.fromEntries(await Promise.all(paths.map(async path=>[
      '/project/'+path.slice(examplePath.length+1),new Uint8Array(await readFile(join(routerRoot,path))),
    ])))
    if(process.env.NATIVE_OWNER_LOCKLESS!=='1'&&!example.fixture)
      throw Error(`${example.name} breadth check requires NATIVE_OWNER_LOCKLESS=1`)
    if(process.env.NATIVE_OWNER_LOCKLESS!=='1')
      files['/project/package-lock.json']=await readFile(resolve(`fixtures/${example.fixture}/package-lock.json`),'utf8')
    return {...example,files,lockless:process.env.NATIVE_OWNER_LOCKLESS==='1',
      warmCache:process.env.NATIVE_OWNER_WARM_CACHE==='1',
      restoreRepeats:process.env.NATIVE_OWNER_RESTORE_REPEATS,
      lightweightRestores:process.env.NATIVE_OWNER_LIGHTWEIGHT_RESTORES==='1',
      classEdit:example.tailwind&&process.env.NATIVE_OWNER_TAILWIND_CLASS_EDIT==='1',
      restart:process.env.NATIVE_OWNER_RESTART==='1',
      viteOnlyProbe:(example.streaming&&example.kind==='react'||example.tailwind)&&
        process.env.NATIVE_OWNER_VITE_ONLY_PROBE==='1',
      production:process.env.NATIVE_OWNER_PRODUCTION==='1'&&
      (example.kind==='solid'||['start-counter','start-basic','start-streaming-data-from-server-functions','basic-ssr-file-based'].includes(example.path))}
  }))
  let hostOrigin=''
  let ownerOrigin=''
  let previewOrigin=''
  let basePreviewOrigin=''
  const failedExamples=[]
  const host=createServer(async(request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    const sdkAsset=sdkAssets.get(new URL(request.url,'http://localhost').pathname)
    if(sdkAsset){
      response.setHeader('Content-Type','text/javascript')
      response.end(await readFile(sdkAsset))
      return
    }
    if(request.url.startsWith('/sdk/')){response.writeHead(404);response.end();return}
    if(request.url==='/host-only-marker'){
      response.setHeader('Content-Type','text/plain')
      response.end('host-only')
      return
    }
    response.setHeader('Content-Type','text/html')
    response.end(`<!doctype html><script>
      window.ownerReady=new Promise(resolve=>addEventListener('message',event=>{
        if(event.origin===${JSON.stringify(ownerOrigin)}&&event.data==='owner-ready')resolve()
      }))
    </script><iframe id="owner" allow="cross-origin-isolated" src="${ownerOrigin}/owner.html${(runtimeCatalog||process.env.NATIVE_OWNER_RUNTIME_SELECTION==='1')&&request.url==='/runtime-selection'?'?runtime-selection=1':''}"></iframe>`)
  })
  const owner=createServer(async(request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    response.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    response.setHeader('X-Content-Type-Options','nosniff')
    if(path==='/owner.html'){
      const probeSource='import {writeFileSync} from "node:fs";let allowed=true;try{await fetch('+JSON.stringify(hostOrigin+'/host-only-marker')+')}catch{allowed=false}writeFileSync("/app/host-fetch.txt",String(allowed));export default {}'
      response.setHeader('Content-Type','text/html')
      response.end(`<!doctype html><script type="module">
        import {NativeDevServer,installNativeOwnerHost} from '/sdk/index.js'
        installNativeOwnerHost({allowedParentOrigin:${JSON.stringify(hostOrigin)},
          buildId:${JSON.stringify(process.env.NATIVE_OWNER_BUILD_IDENTITY==='1'&&!new URL(request.url,'http://localhost').searchParams.has('unidentified')?'native-owner-test-build':undefined)},
          workerURL:${JSON.stringify(workerPath)},previewOrigin:${JSON.stringify(basePreviewOrigin)},
          runtimeCandidates:${JSON.stringify(new URL(request.url,'http://localhost').searchParams.has('runtime-selection')?(runtimeCatalog??(process.env.NATIVE_OWNER_RUNTIME_SELECTION==='1'?[{workerURL:'/runtime/native/missing.js',toolchain:{vite:'8.3.1',rolldown:'1.2.12'}},{workerURL:'/runtime/native/engine.js',toolchain:{vite:'8.3.1',rolldown:'1.2.11'}}]:undefined)):undefined)},
          previewHostSuffix:${JSON.stringify(process.env.NATIVE_OWNER_DYNAMIC_PREVIEW==='1'?'.localhost':undefined)}})
        parent.postMessage('owner-ready',${JSON.stringify(hostOrigin)})
        addEventListener('message',async event=>{
          if(event.origin!==${JSON.stringify(hostOrigin)}||event.data!=='start'||event.ports.length!==1)return
          const reply=event.ports[0]
          const dev=new NativeDevServer({
            '/app/package.json':'{"type":"module"}',
            '/app/index.html':'<script type="module" src="/main.js"><\\/script>',
            '/app/main.js':'document.body.textContent="owner-origin app"',
            '/app/vite.config.js':${JSON.stringify(probeSource)},
          },{workerURL:${JSON.stringify(workerPath)}})
          try{
            const port=await dev.waitForHTTPReady()
            const html=await(await dev.fetch(new Request('http://127.0.0.1:'+port+'/'))).text()
            const hostFetchAllowed=new TextDecoder().decode(await dev.readFile('/app/host-fetch.txt'))==='true'
            await dev.writeFile('/app/main.js','document.body.textContent="restored edit"')
            const checkpoint=await dev.saveCheckpoint('owner-origin-test')
            await dev.dispose()
            const restored=await NativeDevServer.restoreCheckpoint('owner-origin-test',{workerURL:${JSON.stringify(workerPath)}})
            try{
              const restoredPort=await restored.waitForHTTPReady()
              const restoredSource=await(await restored.fetch(new Request('http://127.0.0.1:'+restoredPort+'/main.js'))).text()
              reply.postMessage({ownerOrigin:location.origin,isolated:crossOriginIsolated,port,html,
                hostFetchAllowed,checkpointVersion:checkpoint.snapshotVersion,restoredSource})
            }finally{await restored.dispose().catch(()=>restored.close())}
          }catch(error){reply.postMessage({error:String(error),stack:error?.stack})}
          finally{await dev.dispose().catch(()=>dev.close())}
        })
      </script>`)
      return
    }
    const runtimeRoot=resolve(deployment,'runtime')
    const candidate=/^\/runtime\/(?:native|workers|mvdan-shell)\/[A-Za-z0-9._/-]+$/.test(path)
      ?resolve(deployment,path.slice(1)):undefined
    const asset=sdkAssets.get(path)??
      (candidate?.startsWith(runtimeRoot+sep)?candidate:undefined)
    if(!asset){response.writeHead(404);response.end();return}
    try{
      const bytes=await readFile(asset)
      response.setHeader('Content-Type',path.endsWith('.wasm')?'application/wasm':'text/javascript')
      response.end(nativeInstallTraceResponse(path,bytes,tracedWorkerPaths,process.env.NATIVE_INSTALL_STAGE_TRACE==='1'))
    }catch(error){response.writeHead(404);response.end(String(error))}
  })
  const preview=createServer(async(request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname
    const name=path.startsWith('/__sandbox/')?path.slice('/__sandbox/'.length):''
    if(!['bridge.html','bridge.js','sw.js','inspect.js','websocket.js','request-policy.js'].includes(name)){
      response.writeHead(503);response.end('No workspace attached');return
    }
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    response.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    response.setHeader('Cache-Control','no-store')
    response.setHeader('Service-Worker-Allowed','/')
    response.setHeader('Content-Type',name.endsWith('.html')?'text/html':'text/javascript')
    if(name.endsWith('.html'))response.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'")
    try{response.end(await readFile(join(deployment,'preview-host/__sandbox',name)))}
    catch(error){response.writeHead(500);response.end(String(error))}
  })
  try{
    hostOrigin=await listen(host)
    ownerOrigin=await listen(owner)
    basePreviewOrigin=await listen(preview)
    previewOrigin=process.env.NATIVE_OWNER_DYNAMIC_PREVIEW==='1'
      ?basePreviewOrigin.replace('127.0.0.1','owner-test.localhost'):basePreviewOrigin
    const selectedBrowsers=[chromium,firefox,webkit].filter(browser=>!process.env.NATIVE_TEST_BROWSER||browser.name()===process.env.NATIVE_TEST_BROWSER)
    assert.ok(selectedBrowsers.length,'No desktop browsers matched NATIVE_TEST_BROWSER')
    for(const browserType of selectedBrowsers){
      const browser=await browserType.launch({headless:true})
      try{
        const page=await browser.newPage()
        const failures=[]
        page.on('console',message=>{
          if(message.type()==='error')failures.push(message.text())
          if(process.env.NATIVE_OWNER_TRACE==='1'&&/^\[owner-(?:stage|progress)\]/.test(message.text()))console.log(`${browserType.name()}: ${message.text()}`)
        })
        page.on('pageerror',error=>failures.push(String(error)))
        page.on('requestfailed',request=>failures.push(`${request.url()}: ${request.failure()}`))
        await page.goto(hostOrigin)
        const result=await page.evaluate(async ownerOrigin=>{
          await Promise.race([window.ownerReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owner frame did not become ready')),10000))])
          const channel=new MessageChannel()
          const reply=new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('Owner SDK timed out')),90000)
            channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data)}
          })
          document.querySelector('#owner').contentWindow.postMessage('start',ownerOrigin,[channel.port2])
          return reply
        },ownerOrigin).catch(error=>{throw Error(`${browserType.name()}: ${error}; ${failures.join('; ')}`)})
        assert.equal(result.error,undefined,`${browserType.name()}: ${result.error}\n${result.stack}`)
        assert.equal(result.ownerOrigin,ownerOrigin,browserType.name())
        assert.equal(result.isolated,true,`${browserType.name()} owner frame must be cross-origin isolated`)
        assert.ok(result.port>0,browserType.name())
        assert.match(result.html,/main\.js/,browserType.name())
        assert.equal(result.hostFetchAllowed,false,browserType.name())
        assert.equal(result.checkpointVersion,5,browserType.name())
        assert.match(result.restoredSource,/restored edit/,browserType.name())
        const bridged=await page.evaluate(async({ownerOrigin,previewOrigin,installTest,trace,identity,nativeOnly})=>{
          const mark=(name)=>{window.__ownerStage=name;if(trace)console.log('[owner-stage]',name)}
          mark('connecting')
          const sdk=await import('/sdk/index.js')
          const {NativeOwnerClient,NativeAgentFileSession,runNativeAgentCommand,spawnNativeAgentProcess,AgentSession,NativeAgentBackend}=sdk
          if(nativeOnly&&(sdk.SDK_COMPATIBILITY.apiVersion!==8||'WorkerKernel' in sdk))throw Error('Native package root has the wrong API')
          // Historical mixed artifacts use a different constructor. Native release
          // artifacts must exercise the explicit-backend constructor directly.
          const session=(backend,options={})=>nativeOnly?new AgentSession(backend,options):new AgentSession({}, {kernel:backend,...options})
          const frame=document.querySelector('#owner')
          if(identity){
            const unidentified=document.createElement('iframe')
            unidentified.src=ownerOrigin+'/owner.html?unidentified=1'
            const loaded=new Promise((resolve,reject)=>{
              unidentified.onload=resolve;unidentified.onerror=()=>reject(Error('Unidentified owner did not load'))
            })
            document.body.append(unidentified)
            try{
              await loaded
              let missingError
              try{await NativeOwnerClient.connect(unidentified.contentWindow,ownerOrigin,previewOrigin,{expectedBuildId:'native-owner-test-build'})}
              catch(failure){missingError=String(failure)}
              if(!missingError?.includes('mismatch'))throw Error('Missing native identity was accepted')
              const legacy=await NativeOwnerClient.connect(unidentified.contentWindow,ownerOrigin,previewOrigin)
              legacy.close()
            }finally{unidentified.remove()}
            for(const expectedBuildId of ['wrong-build','']){
              let error
              try{await NativeOwnerClient.connect(frame.contentWindow,ownerOrigin,previewOrigin,{expectedBuildId})}
              catch(failure){error=String(failure)}
              if(!error||!(expectedBuildId?error.includes('mismatch'):error.includes('Invalid native owner build identity')))
                throw Error('Native identity rejection failed: '+String(error))
            }
          }
          const client=await NativeOwnerClient.connect(frame.contentWindow,ownerOrigin,previewOrigin,
            identity?{expectedBuildId:'native-owner-test-build'}:{})
          if(trace)client.subscribeEvents(event=>{
            if(event.type==='progress')console.log('[owner-progress]',event.phase)
          })
          try{
            mark('starting owner project')
            const port=await client.start({
              '/app/package.json':JSON.stringify({name:'owner-result-test',version:'1.0.0',type:'module',scripts:{postinstall:'must-stay-ignored'}}),
              '/app/package-lock.json':JSON.stringify({name:'owner-result-test',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'owner-result-test',version:'1.0.0'}}}),
              '/app/index.html':'<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>',
              '/app/main.js':'if(import.meta.hot)import.meta.hot.accept();document.body.textContent="owner bridge"',
            })
            const committedInstall=await client.installResult()
            if(committedInstall.installed!==0||committedInstall.skippedPlatformPackages.length!==0||committedInstall.ignoredScripts.join(',')!=='/')throw Error('Owner lost committed install decisions')
            const {URLPreview}=await import('/sdk/index.js')
            const target=document.createElement('div')
            target.id='owner-preview'
            document.body.append(target)
            window.ownerPreview=await URLPreview.mount(target,{
              origin:previewOrigin,
              server:{fetch:request=>client.fetch(request),revision:()=>client.workspaceRevision()},
              connectWebSocket:(url,protocols)=>client.connectWebSocket(previewOrigin,url,protocols),
            })
            for(let attempt=0;attempt<100&&!window.ownerPreview.requests.some(request=>request.pathname==='/main.js'&&request.status===200);attempt++)
              await new Promise(resolve=>setTimeout(resolve,50))
            const previewLoaded=window.ownerPreview.requests.some(request=>request.pathname==='/main.js'&&request.status===200)
            let previewInitial=''
            for(let attempt=0;attempt<100;attempt++){
              previewInitial=(await window.ownerPreview.inspect()).text
              if(previewInitial.includes('owner bridge'))break
              await new Promise(resolve=>setTimeout(resolve,50))
            }
            let stableRequests=0,lastRequestCount=-1
            for(let attempt=0;attempt<100&&stableRequests<5;attempt++){
              const count=window.ownerPreview.requests.length
              stableRequests=count===lastRequestCount?stableRequests+1:0
              lastRequestCount=count
              await new Promise(resolve=>setTimeout(resolve,100))
            }
            if(stableRequests<5)throw Error('Owner bridge client module graph did not settle')
            await client.writeFile('/app/main.js','if(import.meta.hot)import.meta.hot.accept();document.body.textContent="owner updated"')
            let previewUpdated=''
            for(let attempt=0;attempt<100;attempt++){
              previewUpdated=(await window.ownerPreview.inspect()).text
              if(previewUpdated.includes('owner updated'))break
              await new Promise(resolve=>setTimeout(resolve,50))
            }
            let previewCommonJS=''
            let previewCSS=false
            if(installTest){
              mark('browser commonjs module')
              await client.writeFile('/app/client.cjs','module.exports={message:"browser commonjs ready"}')
              await client.writeFile('/app/style.css','body { color: rgb(1, 2, 3) }')
              await client.writeFile('/app/main.js','if(import.meta.hot)import.meta.hot.accept();import "./style.css";import value from "./client.cjs";document.body.textContent=value.message')
              for(let attempt=0;attempt<100;attempt++){
                previewCommonJS=(await window.ownerPreview.inspect()).text
                if(previewCommonJS.includes('browser commonjs ready'))break
                await new Promise(resolve=>setTimeout(resolve,50))
              }
              previewCSS=window.ownerPreview.requests.some(request=>request.pathname==='/style.css'&&request.status===200)
              await client.writeFile('/app/main.js','if(import.meta.hot)import.meta.hot.accept();document.body.textContent="owner updated"')
            }
            window.ownerPreview.close()
            if(installTest){
              mark('directory shell commands')
              const treeCommands=[]
              for(const command of ['mkdir -p tree/nested','cp main.js tree/nested/file.js','cp -r tree copied-tree',
                'mv copied-tree moved-tree','rm -r moved-tree','rm -rf absent-tree']){
                const result=await client.terminalCommand(command,'/app')
                treeCommands.push({command,...result})
                if(result.exitCode!==0)throw Error(`Directory command failed: ${JSON.stringify({command,result})}`)
              }
              const treeFile=new TextDecoder().decode(await client.readFile('/app/tree/nested/file.js'))
              let removedTree=false
              try{await client.readFile('/app/moved-tree/nested/file.js')}catch{removedTree=true}
              const protectedRoot=await client.terminalCommand('rm -rf /app','/app')
              mark('commonjs commands')
              const commonJSWrite=await client.terminalCommand("node -e 'require(\"node:fs\").writeFileSync(\"from-commonjs.txt\",\"live\")'",'/app')
                .catch(error=>({error:String(error),events:client.events.filter(event=>event.type==='diagnostic').slice(-5)}))
              if('error' in commonJSWrite)return {commonJSWrite}
              const commonJSFile=new TextDecoder().decode(await client.readFile('/app/from-commonjs.txt'))
              const commonJSFileOps=await client.terminalCommand("node -e 'const fs=require(\"node:fs\"); fs.appendFileSync(\"from-commonjs.txt\",\" more\"); fs.copyFileSync(\"from-commonjs.txt\",\"copied.txt\"); fs.rmSync(\"from-commonjs.txt\"); fs.appendFile(\"copied.txt\",\" callback\",e=>{if(e)throw e;fs.readFile(\"copied.txt\",\"utf8\",(err,text)=>{if(err)throw err;fs.writeFile(\"callback-copy.txt\",text,writeError=>{if(writeError)throw writeError})})})'",'/app')
              const copiedFile=new TextDecoder().decode(await client.readFile('/app/copied.txt'))
              const callbackCopy=new TextDecoder().decode(await client.readFile('/app/callback-copy.txt'))
              await client.writeFile('/app/fs-esm.mjs','import fs from "node:fs"; fs.writeFileSync("from-esm.txt","esm live")')
              mark('esm command')
              const esmFileOps=await client.terminalCommand('node fs-esm.mjs','/app')
              if(esmFileOps.exitCode!==0)throw Error(`ESM command failed: ${JSON.stringify(esmFileOps)}`)
              const esmFile=new TextDecoder().decode(await client.readFile('/app/from-esm.txt'))
              await client.writeFile('/app/dynamic.mjs','export const value=42')
              const dynamicEvalOps=await client.terminalCommand("node -e 'import(\"./dynamic.mjs\").then(module=>console.log(module.value))'",'/app')
              if(dynamicEvalOps.exitCode!==0)throw Error(`Dynamic eval command failed: ${JSON.stringify(dynamicEvalOps)}`)
              if(!dynamicEvalOps.stdout.includes('42'))throw Error(`Dynamic eval output missing: ${JSON.stringify(dynamicEvalOps)}`)
              mark('descriptor command')
              const descriptorOps=await client.terminalCommand("node -e 'const fs=require(\"node:fs\"); const fd=fs.openSync(\"descriptor.txt\",\"w+\"); const written=fs.writeSync(fd,Buffer.from(\"handle\"),0,6,0); const buffer=Buffer.alloc(6); const read=fs.readSync(fd,buffer,0,6,0); const size=fs.fstatSync(fd).size; fs.closeSync(fd); if(written!==6||read!==6||size!==6||buffer.toString()!==\"handle\")throw Error(\"descriptor mismatch\")'",'/app')
              const descriptorFile=new TextDecoder().decode(await client.readFile('/app/descriptor.txt'))
              const promiseHandleOps=await client.terminalCommand("node -e 'const fs=require(\"node:fs\"); fs.promises.open(\"promise-handle.txt\",\"w+\").then(async handle=>{const written=await handle.write(Buffer.from(\"promise\"),0,7,0);const buffer=Buffer.alloc(7);const read=await handle.read(buffer,0,7,0);const stat=await handle.stat();await handle.close();const reader=await fs.promises.open(\"promise-handle.txt\",\"r\");const content=await reader.readFile(\"utf8\");await reader.close();const writer=await fs.promises.open(\"promise-writefile.txt\",\"w\");await writer.writeFile(\"payload\");await writer.close();if(written.bytesWritten!==7||read.bytesRead!==7||stat.size!==7||buffer.toString()!==\"promise\"||content!==\"promise\")throw Error(\"promise handle mismatch\")})'",'/app')
              const promiseHandleFile=new TextDecoder().decode(await client.readFile('/app/promise-handle.txt'))
              const promiseWriteFile=new TextDecoder().decode(await client.readFile('/app/promise-writefile.txt'))
              const stdoutProbe=await client.terminalCommand('node -e "console.log(42)"','/app')
              let streamObserved=''
              mark('stream command')
              const streamController=new AbortController()
              const streamTimeout=setTimeout(()=>streamController.abort(),45000)
              let streamOps
              try{streamOps=await client.terminalCommand("node -e 'const fs=require(\"node:fs\");const out=fs.createWriteStream(\"stream.txt\");out.on(\"error\",e=>{throw e});out.on(\"finish\",()=>{const input=fs.createReadStream(\"stream.txt\");let count=0;input.on(\"data\",bytes=>count+=bytes.length);input.on(\"error\",e=>{throw e});input.on(\"end\",()=>{fs.writeFileSync(\"stream-result.txt\",String(count));if(count!==150000)throw Error(\"stream size mismatch: \"+count);console.log(\"stream ok\")})});out.end(\"x\".repeat(150000))'",'/app',text=>{streamObserved+=text},streamController.signal)}
              finally{clearTimeout(streamTimeout)}
              if(streamOps.exitCode!==0)throw Error(`Stream command failed: ${JSON.stringify(streamOps)}`)
              const streamFileSize=(await client.readFile('/app/stream.txt')).byteLength
              let streamResult=''
              try{streamResult=new TextDecoder().decode(await client.readFile('/app/stream-result.txt'))}catch{}
              const metadataController=new AbortController()
              mark('metadata command')
              const metadataTimeout=setTimeout(()=>metadataController.abort(),45000)
              let metadataOps
              try{metadataOps=await client.terminalCommand("node -e 'const fs=require(\"node:fs\");fs.writeFileSync(\"metadata.txt\",\"hello\");fs.chmodSync(\"metadata.txt\",0o600);fs.utimesSync(\"metadata.txt\",1700000000,1700000001);fs.truncateSync(\"metadata.txt\",4);const fd=fs.openSync(\"metadata.txt\",\"r+\");fs.fchmodSync(fd,0o640);fs.futimesSync(fd,1700000002,1700000003);fs.ftruncateSync(fd,3);fs.closeSync(fd);fs.promises.chmod(\"metadata.txt\",0o644).then(async()=>{await fs.promises.utimes(\"metadata.txt\",1700000004,1700000005);await fs.promises.truncate(\"metadata.txt\",2);const handle=await fs.promises.open(\"metadata.txt\",\"r+\");await handle.chmod(0o600);await handle.utimes(1700000006,1700000007);await handle.truncate(1);await handle.utimes(1700000006,1700000007);await handle.close();const stat=fs.statSync(\"metadata.txt\");if((stat.mode&0o777)!==0o600||stat.size!==1||Math.abs(stat.mtimeMs-1700000007000)>1000)throw Error(\"metadata mismatch: \"+JSON.stringify({mode:stat.mode&0o777,size:stat.size,mtimeMs:stat.mtimeMs}))})'",'/app',undefined,metadataController.signal)}
              finally{clearTimeout(metadataTimeout)}
              if(metadataOps.exitCode!==0)throw Error(`Metadata command failed: ${JSON.stringify(metadataOps)}`)
              let metadataFile='',metadataFileError=''
              try{metadataFile=new TextDecoder().decode(await client.readFile('/app/metadata.txt'))}
              catch(error){metadataFileError=String(error)}
              const beforeCheckpoint=(await client.snapshotWorkspace()).fileTimes?.['/app/metadata.txt']
              mark('checkpoint restore')
              await client.saveCheckpoint('owner-metadata-roundtrip')
              await client.dispose()
              await client.restoreCheckpoint('owner-metadata-roundtrip')
              const afterCheckpoint=(await client.snapshotWorkspace()).fileTimes?.['/app/metadata.txt']
              const restoredMetadataFile=new TextDecoder().decode(await client.readFile('/app/metadata.txt'))
              let removedFile=false
              try{await client.readFile('/app/from-commonjs.txt')}catch{removedFile=true}
              await client.writeFile('/app/package.json',JSON.stringify({name:'owner-install-test',version:'1.0.0',type:'module',
                dependencies:{'is-number':'7.0.0'}}))
              let output=''
              const install=client.openTerminalCommand('npm install','/app',text=>{output+=text})
              mark('npm install')
              const queuedWrite=client.writeFile('/app/queued.txt','not lost during install')
              const result=await install.result
              await queuedWrite
              if(result.exitCode!==0)throw Error(`Install command failed: ${JSON.stringify({result,output,
                recentEvents:client.events.filter(event=>event.type==='progress'||event.type==='diagnostic').slice(-20)})}`)
              const installed=JSON.parse(new TextDecoder().decode(await client.readFile('/app/node_modules/is-number/package.json')))
              const dependencyResult=await client.installResult()
              if(dependencyResult.installed!==1||dependencyResult.ignoredScripts.length||dependencyResult.skippedPlatformPackages.length)throw Error('Dependency install result does not match committed packages')
              const queued=new TextDecoder().decode(await client.readFile('/app/queued.txt'))
              const port=await client.ports()
              const noObserver=await client.terminalCommand('pnpm install','/app')
              if(JSON.stringify(await client.installResult())!==JSON.stringify(dependencyResult))throw Error('No-op install lost committed metadata')
              const installSession=session(new NativeAgentBackend(client))
              const agentInstall=await installSession.install()
              if(JSON.stringify(agentInstall)!==JSON.stringify(dependencyResult))throw Error('Shared agent install did not return committed native results')
              mark('failed install')
              await client.writeFile('/app/package.json','{bad json')
              const failedInstall=await client.openTerminalCommand('npm install','/app').result
              if(JSON.stringify(await client.installResult())!==JSON.stringify(dependencyResult))throw Error('Failed install replaced committed metadata')
              const retained=new TextDecoder().decode(await client.readFile('/app/queued.txt'))
              await client.writeFile('/app/package.json',JSON.stringify({name:'owner-install-test',version:'1.0.0',type:'module',
                dependencies:{'is-number':'7.0.0','left-pad':'1.3.0'}}))
              const interrupted=client.openTerminalCommand('npm install','/app')
              mark('interrupted install')
              interrupted.interrupt()
              const interruptedResult=await interrupted.result
              if(JSON.stringify(await client.installResult())!==JSON.stringify(dependencyResult))throw Error('Cancelled install replaced committed metadata')
              const afterInterrupt=new TextDecoder().decode(await client.readFile('/app/queued.txt'))
              await client.dispose()
              return {result,output,installed:installed.name+'@'+installed.version,queued,port,noObserver,previewCommonJS,previewCSS,
                treeCommands,treeFile,removedTree,protectedRoot,
                commonJSWrite,commonJSFile,commonJSFileOps,copiedFile,callbackCopy,esmFileOps,esmFile,dynamicEvalOps,descriptorOps,descriptorFile,promiseHandleOps,promiseHandleFile,promiseWriteFile,stdoutProbe,streamOps,streamObserved,streamFileSize,streamResult,metadataOps,metadataFile,metadataFileError,beforeCheckpoint,afterCheckpoint,restoredMetadataFile,removedFile,
                failedInstall,retained,interruptedResult,afterInterrupt}
            }
            const socket=await client.connectWebSocket(previewOrigin,await client.hmrURL(),['vite-hmr'])
            const connected=await socket.next()
            await socket.dispose()
            await client.writeFile('/app/note.txt','edited through owner channel')
            const read=new TextDecoder().decode(await client.readFile('/app/note.txt'))
            await client.mkdir('/app/owner-directory/nested',{recursive:true,mode:0o750})
            const directoryRevision=await client.workspaceRevision()
            await client.mkdir('/app/owner-directory/nested',{recursive:true,mode:0o700})
            if(await client.workspaceRevision()!==directoryRevision)throw Error('Owner no-op mkdir advanced revision')
            const ownerShape=await client.snapshotWorkspace()
            if((ownerShape.directoryModes['/app/owner-directory/nested']&0o777)!==0o750)throw Error('Owner directory mode changed')
            const ownerDirectories=await client.listDirectory('/app/owner-directory')
            if(ownerDirectories.length!==1||ownerDirectories[0].name!=='nested'||ownerDirectories[0].type!=='directory')throw Error('Owner mkdir did not create nested directory')
            await client.writeFile('/app/owner-directory/nested/bytes.bin',new Uint8Array([0,128,255]))
            const renameRevision=await client.workspaceRevision()
            await client.rename('/app/owner-directory','/app/owner-moved')
            if(await client.workspaceRevision()!==renameRevision+1)throw Error('Owner rename did not advance revision once')
            await client.rename('/app/owner-moved','/app/owner-moved')
            if(await client.workspaceRevision()!==renameRevision+1)throw Error('Owner no-op rename advanced revision')
            const movedBytes=await client.readFile('/app/owner-moved/nested/bytes.bin')
            if(Array.from(movedBytes).join(',')!=='0,128,255')throw Error('Owner rename changed file bytes')
            const movedShape=await client.snapshotWorkspace()
            if((movedShape.directoryModes['/app/owner-moved/nested']&0o777)!==0o750)throw Error('Owner rename changed directory mode')
            const removeRevision=await client.workspaceRevision()
            let nonRecursiveRejected=false
            try{await client.remove('/app/owner-moved')}catch{nonRecursiveRejected=true}
            if(!nonRecursiveRejected)throw Error('Owner removed a directory without recursive permission')
            if(await client.workspaceRevision()!==removeRevision)throw Error('Failed owner removal advanced revision')
            await client.remove('/app/owner-moved',{recursive:true})
            if(await client.workspaceRevision()!==removeRevision+1)throw Error('Owner removal did not advance revision once')
            await client.remove('/app/owner-moved',{recursive:true,force:true})
            if(await client.workspaceRevision()!==removeRevision+1)throw Error('Owner no-op removal advanced revision')
            const removedShape=await client.snapshotWorkspace()
            if(Object.keys(removedShape.files).some(path=>path.startsWith('/app/owner-moved/'))||Object.keys(removedShape.directoryModes).some(path=>path==='/app/owner-moved'||path.startsWith('/app/owner-moved/')))throw Error('Owner removed tree remains in snapshot')
            if(new TextDecoder().decode(await client.readFile('/app/note.txt'))!=='edited through owner channel')throw Error('Owner removal changed neighboring file')
            await client.restoreWorkspace(movedShape)
            if([...await client.readFile('/app/owner-moved/nested/bytes.bin')].join(',')!=='0,128,255')throw Error('Owner snapshot restore lost binary bytes')
            if([...movedShape.files['/app/owner-moved/nested/bytes.bin']].join(',')!=='0,128,255')throw Error('Owner snapshot restore detached caller bytes')
            const restoredShape=await client.snapshotWorkspace()
            if((restoredShape.directoryModes['/app/owner-moved/nested']&0o777)!==0o750)throw Error('Owner snapshot restore lost directory mode')
            for(const invalid of [
              {...restoredShape,version:4},
              {...restoredShape,files:{...restoredShape.files,'/outside.txt':new Uint8Array([9])}},
              {...restoredShape,fileTimes:Object.fromEntries(Object.keys(restoredShape.files).map(path=>[path,{atimeMs:Infinity,mtimeMs:0}]))},
            ]){
              let rejected=false
              try{await client.restoreWorkspace(invalid)}catch{rejected=true}
              if(!rejected)throw Error('Owner accepted an invalid workspace snapshot')
              if(new TextDecoder().decode(await client.readFile('/app/note.txt'))!=='edited through owner channel')throw Error('Failed restore lost current workspace')
              if([...await client.readFile('/app/owner-moved/nested/bytes.bin')].join(',')!=='0,128,255')throw Error('Failed restore changed current binary file')
              if([...restoredShape.files['/app/owner-moved/nested/bytes.bin']].join(',')!=='0,128,255')throw Error('Failed restore detached caller bytes')
            }
            const listed=await client.listDirectory('/app')
            const commands=await client.listTerminalCommands()
            const agentFiles=new NativeAgentFileSession(client,true)
            await agentFiles.call('mkdir',['/app/agent-files/nested',{recursive:true}])
            await client.writeFile('/app/agent-files/nested/value.txt','native agent files')
            await agentFiles.call('rename',['/app/agent-files','/app/agent-moved'])
            const agentEntries=await agentFiles.call('readdir',['/app/agent-moved',{recursive:true,withFileTypes:true}])
            if(!agentEntries.some(entry=>entry.relativePath==='nested/value.txt'&&entry.kind==='file'))throw Error('Native agent file session listing lost nested file')
            await agentFiles.call('rm',['/app/agent-moved',{recursive:true,force:false}])
            await agentFiles.close()
            const literalArgs=['a b',"a'b",'$(echo should-not-expand)','']
            const agentOutput=[]
            const agentCommand=await runNativeAgentCommand(client,{command:'printf',args:['%s\\n',...literalArgs],cwd:'/app'},{onOutput:(text,stream)=>agentOutput.push({text,stream})})
            const literalExpected=literalArgs.join('\n')+'\n'
            if(agentCommand.status!==0||agentCommand.stdout!==literalExpected||agentCommand.stderr!==''||agentCommand.truncated)throw Error('Native agent command changed literal arguments')
            if(agentOutput.filter(event=>event.stream==='stdout').map(event=>event.text).join('')!==literalExpected)throw Error('Native agent command lost live output')
            const agentProcess=spawnNativeAgentProcess(client,{command:'printf',args:['%s','native process'],cwd:'/app'})
            let processText='',processExit
            for(;;){const event=await agentProcess.next();if(!event)break;if(event.type==='stdout')processText+=new TextDecoder().decode(event.bytes);if(event.type==='exit')processExit=event.code}
            const processStatus=await agentProcess.wait()
            await agentProcess.dispose()
            if(processText!=='native process'||processExit!==0||processStatus.exitCode!==0||processStatus.signal!==null)throw Error('Native agent process stream/completion mismatch')
            const inputBackend=new NativeAgentBackend(client)
            const pipedAgent=await inputBackend.spawn('node',['-e',
              'process.stdin.on("data",chunk=>process.stdout.write(JSON.stringify([...chunk])+"\\n"));process.stdin.on("end",()=>process.stdout.write("EOF\\n"))'],{cwd:'/app',stdio:'pipe'})
            let pipedText=''
            try{
              await pipedAgent.writeInput(new Uint8Array([0,128,255]))
              while(!pipedText.includes('\n')){
                const event=await pipedAgent.next()
                if(!event||event.type==='exit')throw Error('Agent stdin ended before output')
                if(event.type==='stdout')pipedText+=new TextDecoder().decode(event.bytes)
              }
              if(pipedText!=='[0,128,255]\n')throw Error('Agent stdin changed binary bytes: '+JSON.stringify(pipedText))
              await pipedAgent.endInput()
              let rejected=false
              try{await pipedAgent.writeInput('late')}catch{rejected=true}
              if(!rejected)throw Error('Agent stdin accepted input after EOF')
              for(;;){const event=await pipedAgent.next();if(!event)break;
                if(event.type==='stdout')pipedText+=new TextDecoder().decode(event.bytes)}
              if(pipedText!=='[0,128,255]\nEOF\n'||(await pipedAgent.wait()).exitCode!==0)
                throw Error('Agent stdin EOF/completion mismatch: '+JSON.stringify(pipedText))
              rejected=false
              try{await pipedAgent.endInput()}catch{rejected=true}
              if(!rejected)throw Error('Agent stdin accepted EOF after exit')
            }finally{await pipedAgent.dispose()}
            const bulkAgent=await inputBackend.spawn('node',['-e',
              'let bytes=0;process.stdin.on("data",chunk=>{bytes+=chunk.length});process.stdin.on("end",()=>process.stdout.write(String(bytes)))'],{cwd:'/app',stdio:'pipe'})
            try{
              for(let chunk=0;chunk<20;chunk++)await bulkAgent.writeInput(new Uint8Array(65536))
              await bulkAgent.endInput()
              let received=''
              for(;;){const event=await bulkAgent.next();if(!event)break;
                if(event.type==='stdout')received+=new TextDecoder().decode(event.bytes)}
              if(received!==String(20*65536)||(await bulkAgent.wait()).exitCode!==0)
                throw Error('Acknowledged agent bulk stdin mismatch: '+received)
            }finally{await bulkAgent.dispose()}
            const inputSetupFailure=Error('agent input callback failed')
            let observedSetupFailure
            try{await runNativeAgentCommand(client,{command:'node',args:['-e','setInterval(()=>{},1000)'],cwd:'/app'},
              {onInput:()=>{throw inputSetupFailure}})}catch(error){observedSetupFailure=error}
            if(observedSetupFailure!==inputSetupFailure)throw Error('Agent input cleanup replaced callback error')
            if((await client.resources()).commands!==0)throw Error('Agent input failure retained active command')
            const overflowing=spawnNativeAgentProcess(client,{command:'printf',args:['%s','overflow'],cwd:'/app'},{maxQueuedBytes:1})
            let overflowError
            try{await overflowing.wait()}catch(error){overflowError=error}
            await overflowing.dispose()
            if(overflowError?.code!=='ERR_OUTPUT_LIMIT')throw Error('Native process did not enforce its unread output limit')
            await client.writeFile('/app/agent-cancel.cjs','process.stdout.write("ready");setInterval(()=>{},1000);')
            const cancellable=spawnNativeAgentProcess(client,{command:'node',args:['agent-cancel.cjs'],cwd:'/app'})
            const readyEvent=await cancellable.next()
            if(readyEvent?.type!=='stdout'||new TextDecoder().decode(readyEvent.bytes)!=='ready')throw Error('Native cancellable process did not start')
            const activeResources=await client.resources()
            if(activeResources.scope!=='native-owner'||!activeResources.running||activeResources.commands!==1)throw Error('Owner resources missed active command')
            if(!await cancellable.kill())throw Error('Native active process cancellation was not acknowledged')
            let cancellationError
            try{await cancellable.wait()}catch(error){cancellationError=error}
            await cancellable.dispose()
            if(cancellationError?.name!=='AbortError')throw Error('Native process cancellation lost its failure')
            const completedResources=await client.resources()
            if(completedResources.commands!==0||completedResources.installing)throw Error('Owner resources retained completed command')
            const resourceSession=session({resources:()=>client.resources()},{telemetry:{capacity:4}})
            const agentResources=await resourceSession.resources()
            if(agentResources.scope!=='native-owner'||agentResources.commands!==0||resourceSession.telemetry.events()[0]?.type!=='resources.native-owner')throw Error('Shared agent lost native resource scope')
            const nativeRunSession=session({spawn:async(command,args,options)=>spawnNativeAgentProcess(client,{command,args,cwd:options.cwd??'/app'})})
            const nativeRunResult=await nativeRunSession.run({command:'printf',args:['%s','shared native agent'],cwd:'/app'})
            if(nativeRunResult.stdout!=='shared native agent'||nativeRunResult.stderr!==''||nativeRunResult.status!==0||nativeRunResult.signal!==null||nativeRunResult.truncated)throw Error('Shared agent run did not use native process correctly')
            const liveStreams=[]
            const separated=await client.terminalCommand('printf "out\\n"; printf "err\\n" >&2','/app',(text,stream)=>liveStreams.push({text,stream}))
            if(separated.stdout!=='out\n'||separated.stderr!=='err\n')throw Error('Owner terminal merged stdout and stderr')
            if(liveStreams.filter(event=>event.stream==='stdout').map(event=>event.text).join('')!=='out\n'||liveStreams.filter(event=>event.stream==='stderr').map(event=>event.text).join('')!=='err\n')throw Error('Owner live output lost stream labels')
            await client.writeFile('/app/output-budget.cjs','for(let i=0;i<16;i++)process.stdout.write("x".repeat(65536));process.stdout.write("z");process.stderr.write("err");')
            mark('ascii-output-budget-start')
            let liveOutBytes=0,liveErrBytes=0
            const bounded=await client.terminalCommand('node output-budget.cjs','/app',(text,stream)=>{
              const size=new TextEncoder().encode(text).length
              if(stream==='stdout')liveOutBytes+=size;else liveErrBytes+=size
            })
            if(bounded.exitCode!==0||bounded.truncated!==true||new TextEncoder().encode(bounded.stdout+bounded.stderr).length!==1048576||!/^x*$/.test(bounded.stdout)||!'err'.startsWith(bounded.stderr))throw Error('Owner retained output budget was not enforced: '+JSON.stringify({exitCode:bounded.exitCode,truncated:bounded.truncated,stdoutLength:bounded.stdout.length,stderr:bounded.stderr.slice(0,1000),liveOutBytes,liveErrBytes}))
            if(liveOutBytes!==1048577||liveErrBytes!==3)throw Error('Owner output budget dropped live output')
            mark('ascii-output-budget-complete')
            await client.writeFile('/app/output-unicode-budget.cjs','for(let i=0;i<15;i++)process.stdout.write("x".repeat(65536));process.stdout.write("x".repeat(65535));process.stdout.write("é");')
            mark('unicode-output-budget-start')
            let unicodeLiveBytes=0
            const unicodeBounded=await client.terminalCommand('node output-unicode-budget.cjs','/app',text=>{unicodeLiveBytes+=new TextEncoder().encode(text).length})
            if(unicodeBounded.exitCode!==0||unicodeBounded.truncated!==true||unicodeBounded.stdout.length!==1048575||!/^x*$/.test(unicodeBounded.stdout)||unicodeBounded.stderr!==''||unicodeLiveBytes!==1048577)throw Error('Owner Unicode output budget cut was incorrect: '+JSON.stringify({exitCode:unicodeBounded.exitCode,truncated:unicodeBounded.truncated,stdoutLength:unicodeBounded.stdout.length,stderr:unicodeBounded.stderr.slice(0,1000),unicodeLiveBytes}))
            mark('unicode-output-budget-complete')
            const restartedPort=await client.restart()
            const restarted=new TextDecoder().decode(await client.readFile('/app/note.txt'))
            const restartedMain=await(await client.fetch(new Request(`http://127.0.0.1:${restartedPort}/main.js`))).text()
            const checkpoint=await client.saveCheckpoint('owner-channel-test')
            await client.dispose()
            const restoredPort=await client.restoreCheckpoint('owner-channel-test')
            const restored=new TextDecoder().decode(await client.readFile('/app/note.txt'))
            const restartedRestoredPort=await client.restart()
            const restartedRestored=new TextDecoder().decode(await client.readFile('/app/note.txt'))
            const eventCount=client.events.length
            const html=await(await client.fetch(new Request(`http://127.0.0.1:${restartedRestoredPort}/`))).text()
            await client.dispose()
            const streamPort=await client.start({
              '/app/package.json':'{"type":"module"}',
              '/app/server.js':`export default {fetch(){return new Response(new ReadableStream({
                start(controller){controller.enqueue(new TextEncoder().encode('first '));
                  setTimeout(()=>{controller.enqueue(new TextEncoder().encode('second'));controller.close()},30)}
              }),{headers:{'Content-Type':'text/plain','X-Owner-Stream':'yes'}})}}`,
            },{entry:'server.js',serveFetchEntry:true})
            const response=await client.fetch(new Request(`http://127.0.0.1:${streamPort}/`))
            const streamed=await response.text()
            const cancelled=await client.fetch(new Request(`http://127.0.0.1:${streamPort}/`))
            await cancelled.body.cancel()
            const afterCancel=await(await client.fetch(new Request(`http://127.0.0.1:${streamPort}/`))).text()
            mark('complete-native-agent-workflow')
            const agent=session(new NativeAgentBackend(client),{telemetry:{capacity:32}})
            if(!(await agent.list()).some(entry=>entry.path==='/app/server.js'))throw Error('Native agent default listing did not use workspace root')
            await agent.mkdir({path:'/app/agent-workflow'})
            await agent.write({path:'/app/agent-workflow/value.txt',text:'original'})
            const agentListing=await agent.list({path:'/app/agent-workflow'})
            if(!agentListing.some(entry=>entry.path==='/app/agent-workflow/value.txt'))throw Error('Assembled agent listing failed')
            await agent.move({from:'/app/agent-workflow/value.txt',to:'/app/agent-workflow/moved.txt'})
            const agentRun=await agent.run({command:'printf',args:['%s','assembled agent'],cwd:'/app'})
            if(agentRun.stdout!=='assembled agent'||agentRun.status!==0)throw Error('Assembled native agent run failed')
            let inputOutput='',inputReadyResolve
            const inputReady=new Promise(resolve=>{inputReadyResolve=resolve})
            const inputCommand=client.openTerminalCommand(`node -e 'process.stdin.on("data",chunk=>process.stdout.write(JSON.stringify([...chunk])+"\\n"));process.stdin.on("end",()=>process.stdout.write("EOF\\n"))'`,'/app',(text,stream)=>{
              if(stream==='stdout'){inputOutput+=text;if(inputOutput.includes('\n'))inputReadyResolve()}
            })
            inputCommand.writeInput(new Uint8Array([0,128,255]))
            let inputTimer
            try{await Promise.race([inputReady,new Promise((_,reject)=>{inputTimer=setTimeout(()=>reject(Error('Native terminal did not consume stdin before EOF')),5000)})])}
            finally{clearTimeout(inputTimer)}
            if(inputOutput!=='[0,128,255]\n')throw Error('Native terminal changed binary stdin bytes: '+JSON.stringify(inputOutput))
            inputCommand.endInput()
            const inputResult=await inputCommand.result
            if(inputResult.exitCode!==0||inputOutput!=='[0,128,255]\nEOF\n')throw Error('Native terminal lost stdin EOF: '+JSON.stringify({inputResult,inputOutput}))
            let closedInputRejected=false
            try{inputCommand.writeInput('late')}catch{closedInputRejected=true}
            if(!closedInputRejected)throw Error('Native terminal accepted input after EOF')
            const exitedInput=client.openTerminalCommand('printf done','/app')
            await exitedInput.result
            let exitedInputRejected=false
            try{exitedInput.writeInput('late')}catch{exitedInputRejected=true}
            if(!exitedInputRejected)throw Error('Native terminal accepted input after command exit')
            const inputSession=await client.openTerminalSession('/app')
            try{
              for(const line of ['printf done','false']){
                const command=inputSession.runCommand(line)
                await command.result
                for(const action of [()=>command.writeInput('late'),()=>command.resize(80,24)]){
                  let rejected=false
                  try{action()}catch{rejected=true}
                  if(!rejected)throw Error('Persistent shell command accepted input or resize after exit')
                }
              }
            }finally{await inputSession.dispose()}
            const readCommand=async process=>{
              let text=''
              try{for(;;){const event=await process.next();if(!event)break;if(event.type==='stdout')text+=new TextDecoder().decode(event.bytes)}
                const result=await process.wait();if(result.exitCode!==0)throw Error('Environment probe command failed');return text
              }finally{await process.dispose()}
            }
            const environmentScript='process.stdout.write(JSON.stringify(process.env.TANSTACK_AGENT_ENV_PROBE??null))'
            const baselineEnvironment=await readCommand(await agent.kernel.spawn('node',['-e',environmentScript],{cwd:'/app'}))
            const literalEnvironment="a'b $(echo must-not-expand)"
            const scopedEnvironment=await readCommand(await agent.kernel.spawn('node',['-e',environmentScript],{cwd:'/app',env:{TANSTACK_AGENT_ENV_PROBE:literalEnvironment}}))
            const afterEnvironment=await readCommand(await agent.kernel.spawn('node',['-e',environmentScript],{cwd:'/app'}))
            if(scopedEnvironment!==JSON.stringify(literalEnvironment)||afterEnvironment!==baselineEnvironment)throw Error('Native command environment changed literal values or leaked between commands: '+JSON.stringify({baselineEnvironment,scopedEnvironment,afterEnvironment}))
            for(const value of ['',`quotes: ' " backslash: \\ dollars: $HOME $(echo no) newline:\nend`, '🌍']){
              const run=await agent.run({command:'node',args:['-e',environmentScript],cwd:'/app',env:{TANSTACK_AGENT_ENV_PROBE:value}})
              if(run.status!==0||run.stdout!==JSON.stringify(value))throw Error('AgentSession environment did not preserve literal value: '+JSON.stringify({value,run}))
            }
            const agentSnapshot=await agent.snapshot({encoding:'binary'})
            await agent.write({path:'/app/agent-workflow/moved.txt',text:'modified'})
            const replacing=agent.restore({snapshot:agentSnapshot})
            await Promise.resolve()
            let replacementBlocked=false
            try{await agent.run({command:'printf',args:['must not run'],cwd:'/app'})}catch(error){replacementBlocked=String(error).includes('replacement')}
            if(!replacementBlocked)throw Error('Native agent dispatched a process during restore')
            await replacing
            if((await agent.read({path:'/app/agent-workflow/moved.txt'})).text!=='original')throw Error('Assembled native agent restore failed')
            await agent.write({path:'/app/agent-workflow/binary.bin',base64:'AID/'})
            if((await agent.read({path:'/app/agent-workflow/binary.bin',encoding:'base64'})).base64!=='AID/')throw Error('Native agent base64 file roundtrip failed')
            const encodedSnapshot=await agent.snapshot()
            if(encodedSnapshot.files['/app/agent-workflow/binary.bin'].base64!=='AID/')throw Error('Native agent encoded snapshot lost binary bytes')
            await agent.write({path:'/app/agent-workflow/binary.bin',text:'modified'})
            await agent.restore({snapshot:JSON.parse(JSON.stringify(encodedSnapshot))})
            if((await agent.read({path:'/app/agent-workflow/binary.bin',encoding:'base64'})).base64!=='AID/')throw Error('Native agent JSON snapshot restore lost binary bytes')
            await agent.remove({path:'/app/agent-workflow'})
            const finalAgentResources=await agent.resources()
            if(finalAgentResources.scope!=='native-owner'||finalAgentResources.commands!==0)throw Error('Assembled native agent resources failed')
            await agent.write({path:'/app/agent-shutdown.cjs',text:'setInterval(()=>{},1000);'})
            const activeAgentRun=agent.run({command:'node',args:['agent-shutdown.cjs'],cwd:'/app'})
            const runSettled=activeAgentRun.then(()=>({ok:true}),error=>({ok:false,name:error.name}))
            let activeAgentCommand=false
            for(let attempt=0;attempt<100;attempt++){
              if((await agent.resources()).commands===1){activeAgentCommand=true;break}
              await new Promise(resolve=>setTimeout(resolve,10))
            }
            if(!activeAgentCommand)throw Error('Agent shutdown probe never acquired an active command')
            await agent.close()
            const stoppedAgentRun=await runSettled
            if(stoppedAgentRun.ok||stoppedAgentRun.name!=='AbortError')throw Error('Agent close did not cancel its active command')
            if((await agent.call('read',{path:'/app/server.js'})).ok)throw Error('Closed assembled agent accepted read')
            return {port,previewLoaded,previewInitial,previewUpdated,connected,read,listed,commands,restartedPort,restarted,restartedMain,
              checkpointVersion:checkpoint.snapshotVersion,restoredPort,restored,restartedRestoredPort,restartedRestored,
              eventCount,html,streamPort,streamStatus:response.status,streamHeader:response.headers.get('x-owner-stream'),
              streamed,afterCancel}
          }finally{client.close()}
        },{ownerOrigin,previewOrigin,nativeOnly,installTest:process.env.NATIVE_OWNER_INSTALL_TEST==='1',trace:process.env.NATIVE_OWNER_TRACE==='1',identity:process.env.NATIVE_OWNER_BUILD_IDENTITY==='1'})
        if(process.env.NATIVE_OWNER_INSTALL_TEST==='1'){
          assert.equal(bridged.result?.exitCode,0,`${browserType.name()}: ${JSON.stringify(bridged)}; ${failures.join('; ')}`)
          assert.equal(bridged.installed,'is-number@7.0.0',browserType.name())
          assert.match(bridged.previewCommonJS,/browser commonjs ready/,browserType.name())
          assert.equal(bridged.previewCSS,true,browserType.name())
          assert.equal(bridged.treeCommands.length,6,browserType.name())
          assert.match(bridged.treeFile,/owner updated/,browserType.name())
          assert.equal(bridged.removedTree,true,browserType.name())
          assert.equal(bridged.protectedRoot.exitCode,1,browserType.name())
          assert.equal(bridged.commonJSWrite.exitCode,0,browserType.name())
          assert.equal(bridged.commonJSFile,'live',browserType.name())
          assert.equal(bridged.commonJSFileOps.exitCode,0,browserType.name())
          assert.equal(bridged.copiedFile,'live more callback',browserType.name())
          assert.equal(bridged.callbackCopy,'live more callback',browserType.name())
          assert.equal(bridged.esmFileOps.exitCode,0,browserType.name())
          assert.equal(bridged.esmFile,'esm live',browserType.name())
          assert.equal(bridged.dynamicEvalOps.exitCode,0,browserType.name())
          assert.match(bridged.dynamicEvalOps.stdout,/42/,browserType.name())
          assert.equal(bridged.descriptorOps.exitCode,0,browserType.name())
          assert.equal(bridged.descriptorFile,'handle',browserType.name())
          assert.equal(bridged.promiseHandleOps.exitCode,0,browserType.name())
          assert.equal(bridged.promiseHandleFile,'promise',browserType.name())
          assert.equal(bridged.promiseWriteFile,'payload',browserType.name())
          assert.equal(bridged.streamOps.exitCode,0,browserType.name())
          assert.match(bridged.stdoutProbe.stdout,/42/,`${browserType.name()}: ${JSON.stringify(bridged.stdoutProbe)}`)
          assert.match(bridged.streamObserved,/stream ok/,`${browserType.name()}: ${JSON.stringify({result:bridged.streamOps,size:bridged.streamFileSize,streamResult:bridged.streamResult})}`)
          assert.equal(bridged.streamResult,'150000',browserType.name())
          assert.equal(bridged.metadataOps.exitCode,0,`${browserType.name()}: ${JSON.stringify({result:bridged.metadataOps,fileError:bridged.metadataFileError})}`)
          assert.equal(bridged.metadataFile,'h',browserType.name())
          assert.equal(bridged.restoredMetadataFile,'h',browserType.name())
          assert.equal(bridged.beforeCheckpoint?.mtimeMs,1700000007000,browserType.name())
          assert.equal(bridged.afterCheckpoint?.mtimeMs,1700000007000,browserType.name())
          assert.equal(bridged.streamFileSize,150000,browserType.name())
          assert.equal(bridged.removedFile,true,browserType.name())
          assert.equal(bridged.queued,'not lost during install',browserType.name())
          assert.match(bridged.output,/Dependencies ready/,browserType.name())
          assert.ok(bridged.port.length>0,browserType.name())
          assert.equal(bridged.noObserver.exitCode,0,browserType.name())
          assert.match(bridged.noObserver.stdout,/Dependencies ready/,browserType.name())
          assert.equal(bridged.failedInstall.exitCode,1,browserType.name())
          assert.equal(bridged.retained,'not lost during install',browserType.name())
          assert.equal(bridged.interruptedResult.exitCode,130,browserType.name())
          assert.equal(bridged.afterInterrupt,'not lost during install',browserType.name())
          continue
        }
        assert.ok(bridged.port>0,browserType.name())
        assert.equal(bridged.previewLoaded,true,browserType.name())
        assert.ok(bridged.listed.some(entry=>entry.name==='note.txt'&&entry.type==='file'),browserType.name())
        assert.ok(['cd','node','pnpm'].every(command=>bridged.commands.includes(command)),browserType.name())
        assert.match(bridged.previewInitial,/owner bridge/,browserType.name())
        assert.match(bridged.previewUpdated,/owner updated/,browserType.name())
        assert.equal(bridged.connected?.type,'text',browserType.name())
        assert.equal(JSON.parse(bridged.connected.data).type,'connected',browserType.name())
        assert.equal(bridged.read,'edited through owner channel',browserType.name())
        assert.ok(bridged.restartedPort>0,browserType.name())
        assert.equal(bridged.restarted,bridged.read,browserType.name())
        assert.match(bridged.restartedMain,/owner updated/,browserType.name())
        assert.equal(bridged.checkpointVersion,5,browserType.name())
        assert.ok(bridged.restoredPort>0,browserType.name())
        assert.equal(bridged.restored,bridged.read,browserType.name())
        assert.ok(bridged.restartedRestoredPort>0,browserType.name())
        assert.equal(bridged.restartedRestored,bridged.read,browserType.name())
        assert.ok(bridged.eventCount>0,browserType.name())
        assert.match(bridged.html,/main\.js/,browserType.name())
        assert.ok(bridged.streamPort>0,browserType.name())
        assert.equal(bridged.streamStatus,200,browserType.name())
        assert.equal(bridged.streamHeader,'yes',browserType.name())
        assert.equal(bridged.streamed,'first second',browserType.name())
        assert.equal(bridged.afterCancel,'first second',browserType.name())
        if(process.env.NATIVE_OWNER_IDENTITY_ONLY==='1'){
          assert.equal(process.env.NATIVE_OWNER_BUILD_IDENTITY,'1','Identity-only gate requires identity checks')
          console.log(JSON.stringify({browser:browserType.name(),identity:'passed',examples:'not requested'}))
          continue
        }
        const exampleFilter=process.env.NATIVE_OWNER_EXAMPLE?.split(',').map(value=>value.trim()).filter(Boolean)
        const selectedExamples=examples.filter(item=>!exampleFilter?.length||exampleFilter.some(value=>
          `${item.kind}/${item.path}`===value||item.path===value||item.kind===value))
        assert.ok(selectedExamples.length,'No examples matched NATIVE_OWNER_EXAMPLE')
        for(const example of selectedExamples){
          const realPage=await browser.newPage()
          if(example.kind==='react')await realPage.exposeFunction('waitForPinnedExampleClient',async()=>{
            const frame=realPage.frames().find(frame=>frame.url()===previewOrigin+'/')
            assert.ok(frame,'Pinned example preview frame missing')
            await waitForPinnedStartClient(frame,30000)
          })
          const startupObservation=process.env.NATIVE_OWNER_STARTUP_OBSERVE==='1'
            ?observeNativeOwnerStartup(realPage,{previewOrigin}):undefined
          let beforeDisposal
          const fetchConsumption=[]
          const workerIO=[]
          const previewInteractions=[]
          const previewClickListeners=[]
          let previewClickListenersDropped=0
          if(process.env.NATIVE_OWNER_CLICK_LISTENER_OBSERVE==='1')
            await realPage.addInitScript(installNativePreviewClickListenerObservation,{previewOrigin})
          if(process.env.NATIVE_OWNER_INTERACTION_OBSERVE==='1')
            await realPage.addInitScript(installNativePreviewInteractionObservation,{previewOrigin})
          if(process.env.NATIVE_OWNER_WORKER_IO==='1')
            await realPage.addInitScript(installNativeWorkerIOObservation,{ownerOrigin,parentOrigin:hostOrigin})
          if(process.env.NATIVE_OWNER_FETCH_CONSUMPTION==='1')
            await realPage.addInitScript(installFetchConsumptionObservation,{previewOrigin,pathPrefix:'/_serverFn/'})
          if(example.streaming&&process.env.NATIVE_OWNER_STREAM_OBSERVE==='1'){
            await realPage.addInitScript(installNativeStreamObservation,{previewOrigin})
            await realPage.exposeFunction('readNativeStreamObservation',async()=>
              Promise.all(realPage.frames().filter(frame=>frame.url().startsWith(previewOrigin+'/')).map(frame=>
                frame.evaluate(()=>({url:location.pathname,rows:globalThis.__nativeStreamObservation??[],
                  resources:performance.getEntriesByType('resource').filter(entry=>new URL(entry.name).pathname.startsWith('/_serverFn/'))
                    .slice(-8).map(({startTime,requestStart,responseStart,responseEnd,workerStart,duration})=>
                      ({startTime,requestStart,responseStart,responseEnd,workerStart,duration}))})))))
          }
          const realFailures=[]
          realPage.on('pageerror',error=>realFailures.push(String(error)))
          realPage.on('console',message=>{
            if(process.env.NATIVE_OWNER_CLICK_LISTENER_OBSERVE==='1'&&message.text().startsWith('NATIVE_PREVIEW_CLICK_LISTENER ')){
              try{
                const row=JSON.parse(message.text().slice('NATIVE_PREVIEW_CLICK_LISTENER '.length))
                previewClickListeners.push(row)
                if(previewClickListeners.length>512){previewClickListeners.shift();previewClickListenersDropped++}
                console.log(`${browserType.name()} ${example.name}: ${message.text()}`)
              }catch{}
            }
            if(process.env.NATIVE_OWNER_INTERACTION_OBSERVE==='1'&&message.text().startsWith('NATIVE_PREVIEW_INTERACTION ')){
              try{
                const row=JSON.parse(message.text().slice('NATIVE_PREVIEW_INTERACTION '.length))
                previewInteractions.push(row);if(previewInteractions.length>256)previewInteractions.shift()
                console.log(`${browserType.name()} ${example.name}: ${message.text()}`)
              }catch{}
            }
            if(process.env.NATIVE_OWNER_WORKER_IO==='1'&&message.text().startsWith('NATIVE_WORKER_IO ')){
              try{
                const row=JSON.parse(message.text().slice('NATIVE_WORKER_IO '.length))
                workerIO.push(row);if(workerIO.length>512)workerIO.shift()
                console.log(`${browserType.name()} ${example.name}: ${message.text()}`)
              }catch{}
            }
            if(process.env.NATIVE_OWNER_FETCH_CONSUMPTION==='1'&&message.text().startsWith('NATIVE_FETCH_CONSUMPTION ')){
              try{
                const row=JSON.parse(message.text().slice('NATIVE_FETCH_CONSUMPTION '.length))
                if(fetchConsumption.length<257)fetchConsumption.push(row)
                console.log(`${browserType.name()} ${example.name}: ${message.text()}`)
              }catch{}
            }
            if(startupObservation&&message.text().startsWith('NATIVE_OWNER_BEFORE_DISPOSAL ')){
              try{
                beforeDisposal={guest:JSON.parse(message.text().slice('NATIVE_OWNER_BEFORE_DISPOSAL '.length)),
                  network:startupObservation.snapshot()}
                startupObservation.setPhase('disposal')
              }catch(error){beforeDisposal={captureError:String(error),network:startupObservation.snapshot()}}
            }
            if(process.env.NATIVE_OWNER_TRACE==='1'&&/^\[owner-(?:stage|progress)\]/.test(message.text()))
              console.log(`${browserType.name()} ${example.name}: ${message.text()}`)
            if(message.text().startsWith('INSTALL_PHASE_SUMMARY '))console.log(browserType.name(),message.text())
            if(message.text().startsWith('INSTALL_FILESYSTEM_SUMMARY '))console.log(browserType.name(),message.text())
            if(message.text().startsWith('WARM_START_TIMINGS '))console.log(browserType.name(),message.text())
            if(message.text().startsWith('WARM_START_PROGRESS '))console.log(browserType.name(),message.text())
            if(message.type()==='error')realFailures.push(message.text())
            if(message.text().startsWith('[native-restore]'))console.log(message.text())
          })
          realPage.on('requestfailed',request=>realFailures.push(`${request.url()}: ${request.failure()}`))
          let registryBlocked=false
          if(example.warmCache)await realPage.route('https://registry.npmjs.org/**',route=>registryBlocked?route.abort():route.continue())
          if(example.warmCache)await realPage.exposeFunction('blockPackageDownloads',async()=>{
            const frame=realPage.frames().find(frame=>frame.url().startsWith(ownerOrigin+'/owner.html'))
            assert.ok(frame,'Owner frame missing for cache inspection')
            const inventory=await frame.evaluate(async()=>{
              const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('tanstack-sandbox-spike');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
              try{return await new Promise((resolve,reject)=>{
                const tx=db.transaction('package-cache','readonly'),request=tx.objectStore('package-cache').getAll()
                request.onsuccess=()=>resolve(request.result.filter(record=>record.kind==='archive').map(record=>({key:record.key,bytes:record.bytes})))
                request.onerror=()=>reject(request.error)
              })}finally{db.close()}
            })
            const lock=JSON.parse(typeof example.files['/project/package-lock.json']==='string'
              ?example.files['/project/package-lock.json']:new TextDecoder().decode(example.files['/project/package-lock.json']))
            const keys=new Set(inventory.map(record=>record.key))
            const missing=Object.entries(lock.packages).filter(([,pkg])=>pkg.integrity&&pkg.resolved?.startsWith('https://registry.npmjs.org/')&&!keys.has(pkg.integrity)).map(([path])=>path)
            console.log('WARM_CACHE_INVENTORY '+JSON.stringify({entries:inventory.length,bytes:inventory.reduce((sum,record)=>sum+record.bytes,0),missing}))
            registryBlocked=true
          })
          try{
            await realPage.goto(runtimeCatalog||process.env.NATIVE_OWNER_RUNTIME_SELECTION==='1'?hostOrigin+'/runtime-selection':hostOrigin)
            await realPage.evaluate(()=>window.ownerReady)
            const real=await realPage.evaluate(async({ownerOrigin,previewOrigin,example,delayFirstSocket,captureLock,identity,moduleTrace,viteTrace,progressTrace,streamObserve,startupObserve})=>{
          const {NativeOwnerClient,URLPreview}=await import('/sdk/index.js')
          const client=await NativeOwnerClient.connect(document.querySelector('#owner').contentWindow,ownerOrigin,previewOrigin,
            identity?{expectedBuildId:'native-owner-test-build'}:{})
          if(moduleTrace||viteTrace||progressTrace)client.subscribeEvents(event=>{
            if(event.type==='progress')console.info('[owner-progress] '+event.elapsedMs+' '+event.phase)
          })
          let preview,observationError
          try{
            const timings={}
            const startedAt=performance.now()
            let port
            try{
              port=await client.start(example.files,{workspaceRoot:'/project',installCommand:'pnpm install',
                startCommand:'pnpm run dev',previewPort:example.previewPort,
                ...(moduleTrace||viteTrace?{env:{...(moduleTrace?{NATIVE_MODULE_TRACE:'1'}:{}),
                  ...(viteTrace?{NATIVE_VITE_REQUEST_TRACE:['stages','callbacks'].includes(viteTrace)?viteTrace:'1'}:{})}}:{})})
            }catch(error){throw Error(`${error}; events: ${JSON.stringify([
              ...client.events.filter(event=>event.type!=='progress').slice(-24),
              ...client.events.filter(event=>event.type==='progress').slice(-12),
            ])}`)}
            timings.startMs=Math.round(performance.now()-startedAt)
            const startupStages=client.events.filter(event=>event.type==='progress'&&
              !event.phase.startsWith('dependency-installed:')&&!event.phase.startsWith('async-transform-'))
              .map(({phase,elapsedMs,durationMs})=>({phase,elapsedMs,...(durationMs===undefined?{}:{durationMs})}))
            if(example.warmCache){
              await client.dispose()
              await window.blockPackageDownloads()
              const warmStartedAt=performance.now()
              const progressTimer=setInterval(()=>console.info('WARM_START_PROGRESS '+JSON.stringify({
                elapsedMs:Math.round(performance.now()-warmStartedAt),
                progress:client.events.filter(event=>event.type==='progress').slice(-8),
                diagnostics:client.events.filter(event=>event.type==='diagnostic').slice(-4),
              })),10000)
              try{port=await client.start(example.files,{workspaceRoot:'/project',installCommand:'pnpm install',
                startCommand:'pnpm run dev',previewPort:example.previewPort})}
              finally{clearInterval(progressTimer)}
              timings.warmStartMs=Math.round(performance.now()-warmStartedAt)
              console.info('WARM_START_TIMINGS '+JSON.stringify(timings))
            }
            let generatedLockPackages=0
            let generatedLock
            if(example.lockless){
              const lock=JSON.parse(new TextDecoder().decode(await client.readFile('/project/package-lock.json')))
              if(captureLock)generatedLock=lock
              if(lock.lockfileVersion!==3)throw Error(`${example.name} did not save an npm v3 lockfile`)
              generatedLockPackages=Object.keys(lock.packages).length-1
              if(generatedLockPackages<1)throw Error(`${example.name} resolved no dependencies`)
            }
            const response=await client.fetch(new Request(`http://127.0.0.1:${port}/`))
            const html=await response.text()
            const target=document.createElement('div')
            document.body.append(target)
            let releaseFirstSocket=()=>{},firstSocketRequested=false,firstSocketDelayed=false
            const firstSocketGate=delayFirstSocket?new Promise(resolve=>{releaseFirstSocket=resolve}):undefined
            preview=await URLPreview.mount(target,{
              origin:previewOrigin,server:{fetch:request=>client.fetch(request),revision:()=>client.workspaceRevision()},
              connectWebSocket:async(url,protocols)=>{
                if(firstSocketGate&&!firstSocketDelayed){
                  firstSocketDelayed=true;firstSocketRequested=true
                  await firstSocketGate
                }
                return client.connectWebSocket(previewOrigin,url,protocols)
              },
              scriptOrigins:example.path==='basic-ssr-file-based'?['https://unpkg.com']:undefined,
              connectOrigins:example.path==='basic-ssr-file-based'?['https://jsonplaceholder.typicode.com']:undefined,
            })
            let initial=''
            for(let attempt=0;attempt<300;attempt++){
              initial=(await preview.inspect()).text
              if(initial.includes(example.initial))break
              await new Promise(resolve=>setTimeout(resolve,100))
            }
            const modulePath='/'+example.editPath
            for(let attempt=0;attempt<300&&!preview.requests.some(request=>request.pathname===modulePath&&request.status===200);attempt++)
              await new Promise(resolve=>setTimeout(resolve,100))
            if(!preview.requests.some(request=>request.pathname===modulePath&&request.status===200))
              throw Error(`Client module did not load: ${modulePath}; preview requests: ${JSON.stringify(preview.requests.slice(-40))}; owner diagnostics: ${JSON.stringify(client.events.filter(event=>event.type==='diagnostic').slice(-10))}`)
            let stableRequests=0,lastRequestCount=-1
            for(let attempt=0;attempt<300&&stableRequests<5;attempt++){
              const count=preview.requests.length
              stableRequests=count===lastRequestCount?stableRequests+1:0
              lastRequestCount=count
              await new Promise(resolve=>setTimeout(resolve,100))
            }
            if(stableRequests<5)throw Error(`${example.name} client module graph did not settle`)
            // A quiet request list and complete document can precede dynamic
            // route imports and hydration. Use the pinned apps' existing client
            // UI as a test precondition, never a runtime hook or a retry click.
            if(example.kind==='react')await globalThis.waitForPinnedExampleClient()
            let clickedBeforeEdit=''
            if(example.clicked){
              await preview.click('button')
              for(let attempt=0;attempt<300;attempt++){
                clickedBeforeEdit=(await preview.inspect()).text
                if(clickedBeforeEdit.includes(example.clicked))break
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              if(!clickedBeforeEdit.includes(example.clicked))
                throw Error(`${example.name} click result did not appear before edit: ${JSON.stringify({
                  text:clickedBeforeEdit,requests:preview.requests.slice(-20),controls:(await preview.inspect()).controls,
                })}`)
            }
            const route='/project/'+example.editPath
            const source=new TextDecoder().decode(await client.readFile(route))
            const edited=source.replace(example.before,example.after)
            if(edited===source)throw Error(`${example.name} edit target missing`)
            if(delayFirstSocket){
              for(let attempt=0;attempt<100&&!firstSocketRequested;attempt++)
                await new Promise(resolve=>setTimeout(resolve,100))
              if(!firstSocketRequested)throw Error(`${example.name} did not request a preview WebSocket`)
            }
            const documentRequestsBeforeEdit=delayFirstSocket
              ?preview.requests.filter(request=>request.method==='GET'&&request.pathname==='/').length:0
            await client.writeFile(route,edited)
            if(delayFirstSocket)releaseFirstSocket()
            let updated=''
            for(let attempt=0;attempt<300;attempt++){
              try{updated=(await preview.inspect()).text}
              catch(error){
                if(!['Error: Preview navigated','Error: Preview closed or not ready'].includes(String(error)))throw error
                await new Promise(resolve=>setTimeout(resolve,100))
                continue
              }
              if(updated.includes(example.updated)&&!updated.includes(example.initial))break
              await new Promise(resolve=>setTimeout(resolve,100))
            }
            let editDiagnostics
            if(!updated.includes(example.updated)){
              const moduleResponse=await client.fetch(new Request(`http://127.0.0.1:${port}/${example.editPath}`))
              editDiagnostics={moduleStatus:moduleResponse.status,
                moduleHasEdit:(await moduleResponse.text()).includes(example.after),
                ports:await client.ports(),previewDiagnostics:preview.diagnostics.slice(-12),
                ownerDiagnostics:client.events.filter(event=>event.type==='diagnostic').slice(-12)}
            }
            const documentRequestsAfterEdit=delayFirstSocket
              ?preview.requests.filter(request=>request.method==='GET'&&request.pathname==='/').length:0
            let cssProbe
            if(example.tailwind){
              const cssResponse=await client.fetch(new Request(`http://127.0.0.1:${port}/src/styles/app.css?direct`))
              const css=await cssResponse.text()
              cssProbe={status:cssResponse.status,bytes:css.length,blue600:css.includes('.text-blue-600'),
                tail:cssResponse.ok?css.slice(-500):css.slice(0,1200)}
            }
            let cssClassEdit
            if(example.classEdit){
              const source=new TextDecoder().decode(await client.readFile(route))
              if(!source.includes('text-blue-600'))throw Error('Tailwind class edit target missing')
              await client.writeFile(route,source.replace('text-blue-600','text-red-500'))
              for(let attempt=0;attempt<100;attempt++){
                const cssResponse=await client.fetch(new Request(`http://127.0.0.1:${port}/src/styles/app.css?direct`))
                const css=await cssResponse.text()
                cssClassEdit={status:cssResponse.status,red500:css.includes('.text-red-500'),bytes:css.length}
                if(cssClassEdit.status===200&&cssClassEdit.red500)break
                await new Promise(resolve=>setTimeout(resolve,100))
              }
            }
            let restarted
            if(example.restart){
              const eventStart=client.events.length
              const restartedPort=await client.restart()
              preview.navigate('/')
              let restartedText=''
              for(let attempt=0;attempt<300;attempt++){
                try{restartedText=(await preview.inspect()).text}catch{}
                if(restartedText.includes(example.updated))break
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              restarted={port:restartedPort,updated:restartedText.includes(example.updated),
                reinstalled:client.events.slice(eventStart).some(event=>event.type==='progress'&&event.phase==='dependencies-install-started')}
            }
            let queryProbe
            if(example.path==='start-basic-solid-query'){
              try{await preview.click('a[href="/deferred"]')}
              catch(error){if(String(error)!=='Error: Preview navigated')throw error}
              let resolvedText=''
              for(let attempt=0;attempt<300;attempt++){
                try{resolvedText=(await preview.inspect()).text}
                catch(error){
                  if(!['Error: Preview navigated','Error: Preview closed or not ready'].includes(String(error)))throw error
                }
                if(resolvedText.includes('Hello deferred from the server!')&&resolvedText.includes('Count: 0'))break
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              let routeSettled=0,lastRouteRequests=-1
              for(let attempt=0;attempt<300&&routeSettled<5;attempt++){
                const state=await preview.inspect(),count=preview.requests.length
                routeSettled=state.readyState==='complete'&&count===lastRouteRequests?routeSettled+1:0
                lastRouteRequests=count
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              if(routeSettled<5)throw Error('Deferred query client module graph did not settle')
              const queryControls=(await preview.inspect()).controls
              await preview.click('div.p-2 > div > button')
              let incrementedText=''
              for(let attempt=0;attempt<100;attempt++){
                incrementedText=(await preview.inspect()).text
                if(incrementedText.includes('Count: 1'))break
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              queryProbe={resolved:resolvedText.includes('Hello deferred from the server!'),
                initialCount:resolvedText.includes('Count: 0'),incremented:incrementedText.includes('Count: 1'),
                finalText:incrementedText,controls:queryControls}
            }
            let streamCounts=[]
            let streamTexts=[]
            let streamProgressive=[]
            let streamObservations=[]
            let streamDOM=[]
            if(example.streaming){
              let settled=0,lastRequestCount=-1
              for(let attempt=0;attempt<300&&settled<10;attempt++){
                const count=preview.requests.length
                try{
                  const text=(await preview.inspect()).text
                  settled=count===lastRequestCount&&text.includes(example.updated)?settled+1:0
                }catch(error){
                  if(!['Error: Preview navigated','Error: Preview closed or not ready'].includes(String(error)))throw error
                  settled=0
                }
                lastRequestCount=count
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              if(settled<10)throw Error(`${example.name} edited client module graph did not settle`)
              for(const selector of ['#streamed-results button:nth-of-type(1)','#streamed-results button:nth-of-type(2)']){
                const beforeClick=(await preview.inspect()).text
                const baselineFirst=(beforeClick.match(/Number #1:/g)??[]).length
                const baselineLast=(beforeClick.match(/Number #10:/g)??[]).length
                await preview.click(selector)
                const started=performance.now()
                let firstVisible=false
                const observations=[]
                for(let attempt=0;attempt<30;attempt++){
                  const interim=(await preview.inspect()).text
                  const firstCount=(interim.match(/Number #1:/g)??[]).length
                  const lastCount=(interim.match(/Number #10:/g)??[]).length
                  observations.push({elapsedMs:Math.round(performance.now()-started),firstCount,lastCount})
                  if(firstCount>baselineFirst){
                    firstVisible=lastCount===baselineLast&&performance.now()-started<3000
                    break
                  }
                  await new Promise(resolve=>setTimeout(resolve,100))
                }
                streamProgressive.push(firstVisible)
                streamObservations.push(observations)
                let count=0
                let text=''
                for(let attempt=0;attempt<200;attempt++){
                  text=(await preview.inspect()).text
                  count=(text.match(/Number #10:/g)??[]).length
                  if(count>baselineLast)break
                  await new Promise(resolve=>setTimeout(resolve,100))
                }
                streamCounts.push(count)
                streamTexts.push(text.slice(-1200))
              }
              if(streamObserve)streamDOM=await window.readNativeStreamObservation()
            }
            let production
            if(example.production){
              timings.developmentMs=Math.round(performance.now()-startedAt)-timings.startMs
              preview.close()
              preview=undefined
              const viteOnlyProbe=example.viteOnlyProbe
              if((example.streaming||example.tailwind)&&!viteOnlyProbe){
                const typecheck=await client.typecheck()
                if(typecheck.diagnostics.some(diagnostic=>diagnostic.category===1))
                  throw Error(`${example.name} typecheck: ${JSON.stringify(typecheck.diagnostics)}`)
              }
              const buildStartedAt=performance.now()
              const build=viteOnlyProbe?
                {steps:[{kind:'vite-build'}],outputFiles:await client.build()}:
                await client.runBuildScript('build')
              timings.buildMs=Math.round(performance.now()-buildStartedAt)
              const routerProduction=example.path==='basic-ssr-file-based'
              const entry=routerProduction?'/project/server.js':
                example.path==='start-basic'?'/project/.output/server/index.mjs':'/project/dist/server/server.js'
              const builtEntry=routerProduction?'/project/dist/server/entry-server.js':entry
              const entryBytes=(await client.readFile(builtEntry)).byteLength
              const lightweightRestores=example.lightweightRestores
              const controlEntry='/project/__native_restore_control__.mjs'
              if(lightweightRestores)
                await client.writeFile(controlEntry,'export default { fetch() { return new Response("restore control") } }')
              const checkpointKey=`owner-production-${example.kind}-${example.path}`
              const checkpointStartedAt=performance.now()
              const checkpoint=await client.saveCheckpoint(checkpointKey)
              timings.checkpointMs=Math.round(performance.now()-checkpointStartedAt)
              await client.dispose()
              const restoreOptions={
                workspaceRoot:'/project',installDependencies:false,entry,
                serveFetchEntry:!routerProduction&&example.path!=='start-basic',
                staticRoot:!routerProduction&&example.path!=='start-basic'?'/project/dist/client':undefined,
                previewPort:example.previewPort,
                env:{NODE_ENV:'production'},
              }
              const restoreRepeats=Number(example.restoreRepeats??1)
              if(!Number.isSafeInteger(restoreRepeats)||restoreRepeats<1||restoreRepeats>20)
                throw Error('Restore repeat count must be between 1 and 20')
              let productionPort,restoreMs=0
              const restoreTimes=[]
              for(let restoreIndex=0;restoreIndex<restoreRepeats;restoreIndex++){
                const restoreStarted=performance.now()
                const currentRestoreOptions=lightweightRestores&&restoreIndex<restoreRepeats-1?
                  {...restoreOptions,entry:controlEntry,serveFetchEntry:true,staticRoot:undefined}:restoreOptions
                try{productionPort=await client.restoreCheckpoint(checkpointKey,currentRestoreOptions)}
                catch(error){throw Error(`${example.name} restore ${restoreIndex+1}/${restoreRepeats} failed: ${error}; checkpoint: ${JSON.stringify(checkpoint)}; owner stages: ${JSON.stringify(client.events.filter(event=>event.type==='diagnostic'||event.type==='progress'&&!event.phase.startsWith('entry-import-pending')).slice(-40))}; import activity: ${JSON.stringify(client.events.filter(event=>event.type==='progress'&&event.phase.startsWith('entry-import-pending')).slice(-3))}`)}
                restoreMs=Math.round(performance.now()-restoreStarted)
                restoreTimes.push(restoreMs)
                if(restoreRepeats>1)console.info(`[native-restore] ${example.name} ${restoreIndex+1}/${restoreRepeats}: ${restoreMs}ms`)
                if(restoreIndex<restoreRepeats-1)await client.dispose()
              }
              const previewStartedAt=performance.now()
              const productionResponse=await client.fetch(new Request(`http://127.0.0.1:${productionPort}/`))
              const productionHTML=await productionResponse.text()
              const productionTarget=document.createElement('div')
              document.body.append(productionTarget)
              preview=await URLPreview.mount(productionTarget,{
                origin:previewOrigin,server:{fetch:request=>client.fetch(request)},
                scriptOrigins:routerProduction?['https://unpkg.com']:undefined,
                connectOrigins:routerProduction?['https://jsonplaceholder.typicode.com']:undefined,
              })
              let rendered=false
              for(let attempt=0;attempt<300;attempt++){
                rendered=(await preview.inspect()).text.includes(example.kind==='react'&&example.path==='start-counter'?`${example.after} 1?`:example.after)
                if(rendered)break
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              for(let attempt=0;attempt<300&&preview.requests.filter(request=>request.pathname.startsWith('/assets/')&&request.status===200).length<2;attempt++)
                await new Promise(resolve=>setTimeout(resolve,100))
              let settled=0,lastRequestCount=-1
              for(let attempt=0;attempt<300&&settled<10;attempt++){
                const count=preview.requests.length
                settled=count===lastRequestCount?settled+1:0
                lastRequestCount=count
                await new Promise(resolve=>setTimeout(resolve,100))
              }
              if(settled<10)throw Error(`${example.name} production client requests did not settle`)
              let clickState
              let clicked=false
              const productionStreamProgressive=[]
              if(example.tailwind){
                clicked=undefined
              }else if(example.streaming){
                const counts=[]
                for(const selector of ['#streamed-results button:nth-of-type(1)','#streamed-results button:nth-of-type(2)']){
                  const beforeClick=(await preview.inspect()).text
                  const baselineFirst=(beforeClick.match(/Number #1:/g)??[]).length
                  const baselineLast=(beforeClick.match(/Number #10:/g)??[]).length
                  clickState=await preview.click(selector)
                  const started=performance.now()
                  let firstVisible=false
                  for(let attempt=0;attempt<30;attempt++){
                    const interim=(await preview.inspect()).text
                    if((interim.match(/Number #1:/g)??[]).length>baselineFirst){
                      firstVisible=(interim.match(/Number #10:/g)??[]).length===baselineLast&&performance.now()-started<3000
                      break
                    }
                    await new Promise(resolve=>setTimeout(resolve,100))
                  }
                  productionStreamProgressive.push(firstVisible)
                  let count=0
                  for(let attempt=0;attempt<200;attempt++){
                    count=((await preview.inspect()).text.match(/Number #10:/g)??[]).length
                    if(count>baselineLast)break
                    await new Promise(resolve=>setTimeout(resolve,100))
                  }
                  counts.push(count)
                }
                clicked=counts[0]===1&&counts[1]===2
              }else{
                try{clickState=await preview.click(example.path==='start-counter'?'button':
                  routerProduction?'a[href="/posts"]':'a[href="/deferred"]')}
                catch(error){
                  if(!['start-basic','basic-ssr-file-based'].includes(example.path)||
                    String(error)!=='Error: Preview navigated')throw error
                }
                for(let attempt=0;attempt<300;attempt++){
                  let text=''
                  try{text=(await preview.inspect()).text}
                  catch(error){
                    if(!['start-basic','basic-ssr-file-based'].includes(example.path)||
                      !['Error: Preview closed or not ready','Error: Preview navigated'].includes(String(error)))throw error
                  }
                  clicked=example.productionExpected?example.productionExpected.every(expected=>text.includes(expected)):
                    example.kind==='solid'&&example.path==='start-counter'?text.includes('Taps: 1'):
                    example.path==='start-counter'?text.includes(`${example.after} 2?`):
                    routerProduction?text.includes('Select a post.'):
                    text.includes('Hello deferred!')&&text.includes('John Doe')&&text.includes('Tanner Linsley')
                  if(clicked)break
                  await new Promise(resolve=>setTimeout(resolve,100))
                }
              }
              let queryIncremented
              if(example.path==='start-basic-solid-query'){
                let stable=0,lastCount=-1
                for(let attempt=0;attempt<300&&stable<5;attempt++){
                  const state=await preview.inspect(),count=preview.requests.length
                  stable=state.readyState==='complete'&&count===lastCount?stable+1:0
                  lastCount=count
                  await new Promise(resolve=>setTimeout(resolve,100))
                }
                if(stable<5)throw Error('Production query client module graph did not settle')
                await preview.click('div.p-2 > div > button')
                queryIncremented=false
                for(let attempt=0;attempt<100;attempt++){
                  if((await preview.inspect()).text.includes('Count: 1')){queryIncremented=true;break}
                  await new Promise(resolve=>setTimeout(resolve,100))
                }
              }
              let productionCSS
              if(example.tailwind){
                const cssAsset=preview.requests.find(request=>request.pathname.endsWith('.css')&&request.status===200)
                if(cssAsset){
                  const response=await client.fetch(new Request(`http://127.0.0.1:${productionPort}${cssAsset.pathname}`))
                  const css=await response.text()
                  productionCSS={status:response.status,blue600:css.includes('.text-blue-600'),
                    red500:css.includes('.text-red-500'),bytes:css.length}
                }
              }
              timings.productionPreviewMs=Math.round(performance.now()-previewStartedAt)
              timings.totalMs=Math.round(performance.now()-startedAt)
              production={buildSteps:build.steps.length,buildOutputs:build.outputFiles.length,
                entryBytes,checkpointVersion:checkpoint.snapshotVersion,checkpointBytes:checkpoint.bytes,
                checkpointChunks:checkpoint.chunks,restoreMs,restoreTimes,port:productionPort,
                status:productionResponse.status,editedHTML:productionHTML.includes(example.after),rendered,clicked,
                productionCSS,queryIncremented,productionStreamProgressive,viteOnlyProbe,clickText:clickState?.text,requests:preview.requests.slice(-20)}
            }
            return {timings,startupStages,port,status:response.status,ssr:html.includes(example.before),initial,clickedBeforeEdit,updated,
              generatedLockPackages,generatedLock,documentRequestsBeforeEdit,documentRequestsAfterEdit,
              streamCounts,streamTexts,streamProgressive,streamObservations,streamDOM,production,editDiagnostics,restarted,cssProbe,
              cssClassEdit,queryProbe,previewDiagnostics:preview?.diagnostics.slice(-12)??[],requests:preview?.requests.slice(-12)??[]}
          }catch(error){
            observationError=error
            throw error
          }finally{
            // Outer assertions run after evaluation. Capture before cleanup even
            // when evaluation returns normally but a later assertion fails.
            if(startupObserve)try{console.info('NATIVE_OWNER_BEFORE_DISPOSAL '+JSON.stringify({
              error:observationError===undefined?undefined:String(observationError),requests:preview?.requests.slice(-96)??[],diagnostics:preview?.diagnostics.slice(-16)??[],
              events:client.events.filter(event=>event.type==='progress'||event.type==='diagnostic').slice(-96),
            }))}catch{}
            preview?.close();await client.dispose().catch(()=>{});client.close()
          }
            },{ownerOrigin,previewOrigin,example,identity:process.env.NATIVE_OWNER_BUILD_IDENTITY==='1',
              moduleTrace:process.env.NATIVE_OWNER_MODULE_TRACE==='1',
              progressTrace:process.env.NATIVE_OWNER_TRACE==='1',
        viteTrace:['stages','callbacks'].includes(process.env.NATIVE_OWNER_VITE_REQUEST_TRACE??'')?process.env.NATIVE_OWNER_VITE_REQUEST_TRACE:process.env.NATIVE_OWNER_VITE_REQUEST_TRACE==='1',
              streamObserve:process.env.NATIVE_OWNER_STREAM_OBSERVE==='1',
              captureLock:process.env.NATIVE_OWNER_CAPTURE_LOCK==='1',
              startupObserve:!!startupObservation,
              delayFirstSocket:process.env.NATIVE_OWNER_DELAY_FIRST_SOCKET==='1'&&example.path==='basic-ssr-file-based'}).catch(error=>{
              throw Error(`${browserType.name()} ${example.name} owner example: ${error}; ${[...failures,...realFailures].join('; ')}`)
            })
            if(real.generatedLock){
              const capture=await mkdtemp(join(tmpdir(),'native-owner-lock-'))
              await writeFile(join(capture,'package-lock.json'),JSON.stringify(real.generatedLock,null,2)+'\n')
              await writeFile(join(capture,'source.json'),JSON.stringify({browser:browserType.name(),example:example.name,
                sdkRoot,deployment,files:Object.fromEntries(Object.entries(example.files).map(([path,contents])=>
                  [path,typeof contents==='string'?contents:new TextDecoder().decode(contents)]))},null,2)+'\n')
              console.log(JSON.stringify({browser:browserType.name(),example:example.name,dependencyCapture:capture}))
              delete real.generatedLock
            }
            assert.ok(real.port>0,`${browserType.name()} ${example.name}`)
            assert.ok(real.startupStages.length>0,'Startup must retain progress events')
            assert.ok(real.startupStages.every(({elapsedMs},index,stages)=>
              Number.isSafeInteger(elapsedMs)&&elapsedMs>=0&&(index===0||elapsedMs>=stages[index-1].elapsedMs)),
              'Startup progress must use one numeric, nondecreasing receiver clock')
            assert.equal(real.status,200,`${browserType.name()} ${example.name}`)
            assert.equal(real.ssr,true,`${browserType.name()} ${example.name}`)
            assert.ok(real.initial.includes(example.initial),`${browserType.name()} ${example.name} initial preview`)
            assert.ok(real.updated.includes(example.updated),`${browserType.name()} ${example.name} edited preview: ${JSON.stringify({real,errors:realFailures})}`)
            if(process.env.NATIVE_OWNER_DELAY_FIRST_SOCKET==='1'&&example.path==='basic-ssr-file-based')
              assert.ok(real.documentRequestsAfterEdit>real.documentRequestsBeforeEdit,
                `${browserType.name()} ${example.name} late WebSocket did not reload the document: ${JSON.stringify(real)}`)
            if(example.path==='start-basic-solid-query')assert.deepEqual({resolved:real.queryProbe?.resolved,
              initialCount:real.queryProbe?.initialCount,incremented:real.queryProbe?.incremented},
              {resolved:true,initialCount:true,incremented:true},`${browserType.name()} ${example.name} deferred query interaction: ${JSON.stringify(real)}`)
            if(example.tailwind){
              assert.equal(real.cssProbe?.status,200,`${browserType.name()} ${example.name} CSS response: ${JSON.stringify(real)}`)
              assert.equal(real.cssProbe?.blue600,true,`${browserType.name()} ${example.name} Tailwind utility: ${JSON.stringify(real)}`)
            }
            if(example.classEdit){
              assert.equal(real.cssClassEdit?.status,200,`${browserType.name()} ${example.name} edited CSS response: ${JSON.stringify(real)}`)
              assert.equal(real.cssClassEdit?.red500,true,`${browserType.name()} ${example.name} edited Tailwind utility: ${JSON.stringify(real)}`)
            }
            if(example.restart){
              assert.ok(real.restarted?.port>0,`${browserType.name()} ${example.name} restart port`)
              assert.equal(real.restarted.updated,true,`${browserType.name()} ${example.name} restart kept edit: ${JSON.stringify(real)}`)
              assert.equal(real.restarted.reinstalled,false,`${browserType.name()} ${example.name} restart reinstalled dependencies`)
            }
            if(example.streaming&&process.env.NATIVE_OWNER_STREAM_OBSERVE==='1'){
              console.log('NATIVE_STREAM_OBSERVATION '+JSON.stringify({browser:browserType.name(),example:example.name,
                progressive:real.streamProgressive,inspection:real.streamObservations,frames:real.streamDOM}))
            }
            if(example.streaming)assert.deepEqual(real.streamCounts,[1,2],`${browserType.name()} ${example.name} streaming interactions: ${JSON.stringify(real)}`)
            if(example.streaming)assert.deepEqual(real.streamProgressive,[true,true],`${browserType.name()} ${example.name} incremental streaming: ${JSON.stringify(real)}`)
            if(example.production){
              assert.ok(real.production.buildSteps>0&&real.production.buildOutputs>0,`${browserType.name()} production build: ${JSON.stringify(real)}`)
              assert.ok(real.production.entryBytes>0,`${browserType.name()} production entry: ${JSON.stringify(real)}`)
              assert.equal(real.production.checkpointVersion,5,`${browserType.name()} production checkpoint`)
              assert.ok(real.production.port>0,`${browserType.name()} production port`)
              assert.equal(real.production.status,200,`${browserType.name()} production response: ${JSON.stringify(real)}`)
              assert.equal(real.production.editedHTML,true,`${browserType.name()} production source edit: ${JSON.stringify(real)}`)
              assert.equal(real.production.rendered,true,`${browserType.name()} production preview: ${JSON.stringify(real)}`)
              if(example.path==='start-basic-solid-query')assert.equal(real.production.queryIncremented,true,
                `${browserType.name()} production query counter hydration: ${JSON.stringify(real)}`)
              if(example.streaming)assert.deepEqual(real.production.productionStreamProgressive,[true,true],
                `${browserType.name()} production incremental streaming: ${JSON.stringify(real)}`)
              if(example.tailwind){
                assert.equal(real.production.productionCSS?.status,200,`${browserType.name()} production CSS response: ${JSON.stringify(real)}`)
                assert.equal(example.classEdit?real.production.productionCSS?.red500:
                  real.production.productionCSS?.blue600,true,
                  `${browserType.name()} production Tailwind utility: ${JSON.stringify(real)}`)
              }else assert.equal(real.production.clicked,true,`${browserType.name()} production hydration: ${JSON.stringify({real,errors:realFailures})}`)
            }
            writeNativeOwnerTimings({enabled:process.env.NATIVE_OWNER_TIMINGS==='1',
              browser:browserType.name(),example:example.kind+'/'+example.path,result:real})
            console.log(JSON.stringify({browser:browserType.name(),example:example.name,
              development:'passed',restart:example.restart?'passed':'not requested',
              productionBuild:example.production?(real.production.viteOnlyProbe?'Vite API':'declared-script API'):'not requested',
              production:example.production?(real.production.viteOnlyProbe?'Vite-only probe':'passed'):'not requested'}))
          }catch(error){
            if(startupObservation){
              try{
                const capture=await mkdtemp(join(tmpdir(),'native-owner-startup-'))
                await writeFile(join(capture,'failure.json'),JSON.stringify({browser:browserType.name(),browserVersion:browser.version(),
                  example:example.name,sdkRoot,deployment,error:String(error),beforeDisposal,
                  afterDisposal:startupObservation.snapshot(),fetchConsumption,workerIO,previewInteractions,
                  previewClickListeners,previewClickListenersDropped},null,2)+'\n',{flag:'wx'})
                console.log('NATIVE_OWNER_STARTUP_FAILURE '+JSON.stringify({browser:browserType.name(),example:example.name,capture}))
              }catch(captureError){console.error('Startup capture failed: '+String(captureError))}
            }
            console.log(JSON.stringify(recordAcceptanceFailure(failedExamples,
              {browser:browserType.name(),example:example.name},error,process.env.NATIVE_OWNER_CONTINUE_ON_FAILURE==='1')))
          }finally{startupObservation?.stop();await realPage.close()}
        }
      }finally{await browser.close()}
    }
    assertAcceptancePassed(failedExamples,'owner example')
  }finally{await close(preview);await close(owner);await close(host)}
})
