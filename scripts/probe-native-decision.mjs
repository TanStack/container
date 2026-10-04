import {build,transform} from 'esbuild'
import {readFile,writeFile,mkdtemp} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import {createServer} from 'vite'
import {chromium,firefox,expect} from '@playwright/test'
import {createServer as createHTTPServer} from 'node:http'
import {verifyNativeDecisionEvidence} from './native-decision-evidence.mjs'

const output=await mkdtemp(join(tmpdir(),'native-decision-'))
const bootstrap=await readFile('src/sandbox/engine-als-bootstrap.js','utf8')
const original=JSON.parse(await readFile('src/feasibility/als-cases.json','utf8'))
const hostCases=JSON.parse(await readFile('src/feasibility/native-context-host-cases.json','utf8'))
globalThis.__nativeLibrary=async storage=>{await 0;return storage.getStore()}
const cases=[]
for(const fixture of [...original,...hostCases]){
  const expected=JSON.stringify(await new Function('ALS',`return (async()=>{${fixture.code}})()`)(AsyncLocalStorage))
  const code=`(async()=>{const ALS=globalThis.__engineAsyncLocalStorage;${fixture.code}})()`
  cases.push({id:fixture.id,expected,raw:code,lowered:(await transform(`globalThis.__result=${code}`,{target:'es2016'})).code+'\nglobalThis.__result;'})
}
const aliases={'node:buffer':'buffer/','node:events':'events/','node:path':'path-browserify','node:stream':'stream-browserify'}
await build({entryPoints:['src/feasibility/native-host.worker.js'],bundle:true,format:'esm',platform:'browser',alias:aliases,outfile:join(output,'host.js')})
await build({entryPoints:['src/feasibility/browser-native.worker.js'],bundle:true,format:'esm',platform:'browser',external:['/engine.mjs'],outfile:join(output,'probe.js')})
execFileSync(process.execPath,['scripts/build-browser-vite.mjs'],{env:{...process.env,BROWSER_VITE_OUTPUT_DIRECTORY:join(output,'vite-runtime')},stdio:'inherit'})
execFileSync(process.execPath,['scripts/build-browser-vite.mjs'],{env:{...process.env,BROWSER_VITE_OUTPUT_DIRECTORY:join(output,'vite-dev-runtime'),BROWSER_VITE_ENTRY_POINT:resolve('src/feasibility/native-vite-dev.worker.ts')},stdio:'inherit'})
const report={generatedAt:new Date().toISOString(),output,node:process.version,cases,
  constraints:{trustedFixturesOnly:true,productionBackendChanged:false,memoryStress:false,fullyCompatibleNode:false},
  startRuntime:'src/native/kernel.ts',
  hashes:Object.fromEntries(await Promise.all(['src/native/kernel.ts','src/native/kernel.worker.ts','src/native/async-context.ts','src/feasibility/native-context.js','src/feasibility/native-host.worker.js','scripts/build-browser-vite.mjs'].map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')]))),browsers:[]}
const reportPath=resolve('reports',`native-decision-${report.generatedAt.replaceAll(':','-')}.json`)
const server=await createServer({server:{host:'127.0.0.1',port:0,headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}},plugins:[{
  name:'native-decision-owned-assets',configureServer(server){server.middlewares.use(async(req,res,next)=>{
    const paths={'/native-decision':null,'/native-host.js':join(output,'host.js'),'/native-probe.js':join(output,'probe.js'),'/native-vite-dev.js':join(output,'vite-dev-runtime/engine.js'),'/vite-runtime/engine.js':join(output,'vite-runtime/engine.js'),'/vite-runtime/esbuild.wasm':join(output,'vite-runtime/esbuild.wasm')}
    if(!Object.hasOwn(paths,req.url))return next()
    try{res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':req.url==='/native-decision'?'text/html':'text/javascript');res.end(paths[req.url]?await readFile(paths[req.url]):'<!doctype html><title>Native decision probe</title>')}catch(error){res.statusCode=500;res.end(String(error))}
  })},
}]})
await server.listen()
const previewServer=createHTTPServer((_req,res)=>{res.statusCode=503;res.end('Preview requests must be handled by the test transport')})
await new Promise(resolve=>previewServer.listen(0,'127.0.0.1',resolve))
const previewOrigin=`http://127.0.0.1:${previewServer.address().port}`
try{
  for(const [name,type] of [['chromium',chromium],['firefox',firefox]]){
    const browser=await type.launch({headless:true})
    const result={name,version:browser.version(),pageErrors:[],consoleErrors:[]}
    report.browsers.push(result)
    try{
      const page=await browser.newPage()
      page.on('pageerror',error=>result.pageErrors.push(String(error)))
      page.on('console',message=>{if(message.type()==='error')result.consoleErrors.push(message.text())})
      await page.route('https://registry.npmjs.org/**',route=>route.abort())
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/native-decision`)
      result.context=await page.evaluate(async({cases,bootstrap})=>{
        const rows=[]
        for(const fixture of cases){
          const row={id:fixture.id,expected:fixture.expected}
          for(const mode of ['raw','lowered'])row[mode]=await new Promise(resolve=>{
            const worker=new Worker('/native-probe.js',{type:'module'})
            const finish=result=>{clearTimeout(timer);worker.terminate();resolve({...result,matches:result.ok&&JSON.stringify(result.value)===fixture.expected})}
            const timer=setTimeout(()=>finish({ok:false,error:'timeout'}),10000)
            worker.onerror=event=>finish({ok:false,error:event.message})
            worker.onmessage=event=>finish(event.data)
            worker.postMessage({mode:'native',hostCallbacks:true,code:fixture[mode],bootstrap:`globalThis.__nativeLibrary=async storage=>{await 0;return storage.getStore()};\n${bootstrap}`})
          })
          rows.push(row)
        }
        return rows
      },{cases,bootstrap})
      console.log(name,'context',result.context.filter(row=>row.lowered.matches).length+'/'+cases.length)
      result.viteDev=await page.evaluate(()=>new Promise(resolve=>{
        const worker=new Worker('/native-vite-dev.js',{type:'module'})
        const finish=result=>{clearTimeout(timer);worker.terminate();resolve(result)}
        const timer=setTimeout(()=>finish({error:'Dev server probe timeout'}),30000)
        worker.onerror=event=>finish({error:event.message})
        worker.onmessage=({data})=>{
          if(data.type==='ready')worker.postMessage({files:{'/app/package.json':'{"type":"module"}','/app/index.html':'<script type="module" src="/main.js"></script>','/app/main.js':'if(import.meta.hot)import.meta.hot.accept();document.body.textContent="native dev"'}})
          else finish(data)
        }
      }))
      console.log(name,'vite-dev',JSON.stringify(result.viteDev))
      result.workloads=await page.evaluate(async({bootstrap})=>{
        const {loadBrowserViteEngine}=await import('/src/vite-browser/client.ts')
        const {NativeKernel}=await import('/src/native/kernel.ts')
        const {fingerprintFiles}=await import('/src/feasibility/native-workspace-evidence.ts')
        // The host compiles only the pinned toolchain. Project Vite/Start builds
        // and locked archive installation below execute inside the browser.
        const engine=await loadBrowserViteEngine(),results=[]
        const installed=new NativeKernel()
        const lock=await(await fetch('/start-fixture/browser-build-local-lock.json')).json()
        const manifest=await(await fetch('/start-fixture/project-manifest.json')).json()
        const started=performance.now()
        let snapshot
        let installedPackages
        try{
          await installed.initialize()
          installedPackages=(await installed.installLocked(lock)).packages
          for(const file of manifest.files)await installed.writeFile('/app/'+file,new Uint8Array(await(await fetch('/start-fixture/project/'+file)).arrayBuffer()))
          snapshot=await installed.snapshot()
        }finally{installed.close()}
        const install={runtime:'native-worker',durationMs:performance.now()-started,packages:installedPackages,files:Object.keys(snapshot).length,bytes:Object.values(snapshot).reduce((n,b)=>n+b.length,0),sha256:await fingerprintFiles(snapshot)}
        // Retain exact installed bytes across page reload without reinstalling.
        await new Promise((resolve,reject)=>{const open=indexedDB.open('native-decision',1);open.onupgradeneeded=()=>open.result.createObjectStore('snapshots');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').put(snapshot,'workspace');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}})
        const runVite=async marker=>{
          const built=await engine.runBrowserViteSmokeBuild({'/app/package.json':'{"type":"module"}','/app/src/main.ts':`import {value} from './value';export const answer=value;export const marker='${marker}'`,'/app/src/value.ts':'export const value:number=42'})
          const entry=Object.entries(built.files).find(([path])=>path.endsWith('.js'))
          if(!entry)throw Error('No Vite JS output')
          const url=URL.createObjectURL(new Blob([entry[1]],{type:'text/javascript'}))
          try{const mod=await import(/* @vite-ignore */url);return {marker,actual:mod.marker,answer:mod.answer,durationMs:built.duration,passed:mod.marker===marker&&mod.answer===42}}finally{URL.revokeObjectURL(url)}
        }
        for(const marker of ['initial','edited','initial'])results.push({type:'vite-build',...await runVite(marker)})
        const files=Object.fromEntries(Object.entries(snapshot).map(([path,bytes])=>[path.startsWith('/node_modules/')?'/app'+path:path,bytes]))
        try{
          const built=await engine.runBrowserStartBuild(files)
          const makeHost=()=>{
            const kernel=new NativeKernel()
            return {close:()=>kernel.close(),call:async({operation,...message})=>{
              try{
                const value=operation==='initialize'
                  ?await kernel.initialize(message.files)
                  :operation==='loadEntry'
                    ?await kernel.loadEntry(message.entry,{asyncContext:true})
                  :operation==='request'
                    ?await kernel.request(message)
                    :operation==='snapshot'
                      ?await kernel.snapshot()
                      :undefined
                if(value===undefined)throw Error('Unknown native kernel operation')
                return {ok:true,value}
              }catch(error){return {ok:false,error:String(error)}}
            }}
          }
          const host=makeHost(),call=host.call
          try{
            await call({operation:'initialize',files:{...files,...built.files}})
            const load=await call({operation:'loadEntry',entry:'/app/dist/server/server.js'})
            const responses=load.ok?await Promise.all(['/','/about','/'].map(path=>call({operation:'request',url:'http://native.invalid'+path}))):[]
            results.push({type:'start-build-and-native-ssr',execution:'worker-owned-entry',buildMs:built.duration,artifacts:Object.keys(built.files),load,responses})
            const rebuild=async()=>{
              globalThis.__nativeDepth.close()
              const path='/app/src/routes/index.tsx'
              files[path]=new TextEncoder().encode(new TextDecoder().decode(files[path]).replace('Bare-bones Start','Native edited Start'))
              const updated=await engine.runBrowserStartBuild(files)
              const next=makeHost()
              globalThis.__nativeDepth={...next,assets:updated.files}
              await next.call({operation:'initialize',files:{...files,...updated.files}})
              const loaded=await next.call({operation:'loadEntry',entry:'/app/dist/server/server.js'})
              return {loaded,buildMs:updated.duration}
            }
            globalThis.__nativeDepth={...host,assets:built.files,rebuild}
          }catch(error){host.close();throw error}
        }catch(error){results.push({type:'start-build-and-native-ssr',error:String(error),stack:error.stack})}
        return {install,results}
      },{bootstrap})
      console.log(name,'workloads',JSON.stringify(result.workloads.results.map(({responses,...row})=>({...row,responses:responses?.map(r=>({...r,value:r.value?{status:r.value.status,bytes:r.value.body.length}:undefined}))}))))
      // Harness-only HTTP transport. Guest execution stays in the owner's
      // native worker; this is not acceptance of production preview hosting.
      const preview=await browser.newPage()
      result.preview={errors:[],requests:[]}
      preview.on('pageerror',error=>result.preview.errors.push(String(error)))
      await preview.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url())
        if(url.origin!==previewOrigin)return route.abort()
        try{
          const response=await page.evaluate(async({url,method,body,headers})=>{
            const host=globalThis.__nativeDepth
            if(!host)throw Error('Native host did not load')
            const asset=host.assets['/app/dist/client'+new URL(url).pathname]
            if(asset)return {status:200,headers:[['content-type',url.endsWith('.css')?'text/css':'text/javascript']],body:new TextDecoder().decode(asset)}
            const reply=await host.call({operation:'request',url,method,body,headers})
            if(!reply.ok)throw Error(reply.error)
            return reply.value
          },{url:request.url(),method:request.method(),body:request.postData()??undefined,headers:await request.allHeaders()})
          result.preview.requests.push({method:request.method(),path:url.pathname,status:response.status})
          await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:response.body})
        }catch(error){result.preview.errors.push(String(error));await route.fulfill({status:500,body:String(error)})}
      })
      try{
        await preview.goto(previewOrigin)
        await expect(preview.locator('main')).toHaveAttribute('data-hydrated','true',{timeout:15000})
        await preview.locator('#start-count').click()
        await expect(preview.locator('#start-count')).toHaveText('Count: 1')
        await preview.locator('#server-call').click()
        await expect(preview.locator('#server-reply')).toContainText('"method":"POST"',{timeout:15000})
        result.preview.serverReply=await preview.locator('#server-reply').textContent()
        const serverPath=result.preview.requests.find(request=>request.method==='POST').path
        result.preview.mismatchedOrigin=await page.evaluate(async({url})=>{
          const reply=await globalThis.__nativeDepth.call({operation:'request',url,method:'POST',headers:{origin:'https://unrelated.invalid','sec-fetch-site':'cross-site'},body:'{}'})
          return {ok:reply.ok,status:reply.value?.status}
        },{url:previewOrigin+serverPath})
        if(result.preview.mismatchedOrigin.status!==403)throw Error('Start did not reject mismatched origin')
        await preview.locator('#about-link').click()
        await expect(preview.locator('#about-title')).toHaveText('Second route')
        await preview.locator('#home-link').click()
        await expect(preview.locator('main')).toHaveAttribute('data-hydrated','true')
        result.preview.edit=await page.evaluate(()=>globalThis.__nativeDepth.rebuild())
        await preview.reload()
        await expect(preview.locator('h1')).toHaveText('Native edited Start')
        await expect(preview.locator('main')).toHaveAttribute('data-hydrated','true')
        result.preview.passed=true
      }catch(error){result.preview.passed=false;result.preview.failure=String(error)}finally{await preview.close();await page.evaluate(()=>globalThis.__nativeDepth?.close())}
      console.log(name,'preview',JSON.stringify(result.preview))
      await page.route('**/start-fixture/archives/**',route=>route.abort())
      await page.reload()
      result.resume=await page.evaluate(async()=>{
        const snapshot=await new Promise((resolve,reject)=>{const open=indexedDB.open('native-decision',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('snapshots','readonly'),request=tx.objectStore('snapshots').get('workspace');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);tx.oncomplete=()=>db.close()}})
        const {loadBrowserViteEngine}=await import('/src/vite-browser/client.ts')
        const {fingerprintFiles}=await import('/src/feasibility/native-workspace-evidence.ts')
        const engine=await loadBrowserViteEngine()
        const files=Object.fromEntries(Object.entries(snapshot).map(([path,bytes])=>[path.startsWith('/node_modules/')?'/app'+path:path,bytes]))
        try{const built=await engine.runBrowserStartBuild(files);return {files:Object.keys(snapshot).length,bytes:Object.values(snapshot).reduce((n,b)=>n+b.length,0),sha256:await fingerprintFiles(snapshot),artifacts:Object.keys(built.files),durationMs:built.duration}}catch(error){return {error:String(error)}}
      })
      result.controls=await page.evaluate(async({bootstrap})=>{
        const started=performance.now()
        const url=URL.createObjectURL(new Blob([`postMessage('started');const until=Date.now()+2000;while(Date.now()<until){};postMessage('finished')`],{type:'text/javascript'}))
        let completed=false,ticks=0
        const heartbeat=setInterval(()=>ticks++,10)
        const worker=new Worker(url)
        try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker startup timeout')),10000);worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message))};worker.onmessage=e=>{if(e.data==='finished')completed=true;if(e.data==='started'){clearTimeout(timer);setTimeout(()=>{worker.terminate();resolve()},100)}}});await new Promise(resolve=>setTimeout(resolve,100))}finally{worker.terminate();clearInterval(heartbeat);URL.revokeObjectURL(url)}
        const {createNativeHost}=await import('/src/feasibility/native-host-client.ts')
        const host=createNativeHost()
        await host.call({operation:'load',bootstrap,code:`export default async()=>{await new Promise(resolve=>setTimeout(resolve,2000));return new Response('done')}`})
        const pending=host.call({operation:'request',url:'http://native.invalid/'})
        setTimeout(()=>host.close(),25)
        let pendingRejected=false
        try{await pending}catch(error){pendingRejected=String(error).includes('Native host closed')}finally{host.close()}
        return {terminatedBeforeCompletion:!completed,pendingRejected,hostHeartbeatTicks:ticks,wallMs:performance.now()-started,AsyncContext:typeof globalThis.AsyncContext,heapQuota:'Not implemented; WorkerOptions provides no heap quota'}
      },{bootstrap})
    }catch(error){result.fatal={error:String(error),stack:error.stack};console.error(name,error)}finally{await browser.close();const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(join(output,'report.json'),bytes);await writeFile(reportPath,bytes)}
  }
}finally{await server.close();await new Promise(resolve=>previewServer.close(resolve))}
console.log('REPORT='+reportPath)
console.log(JSON.stringify(verifyNativeDecisionEvidence(report)))
