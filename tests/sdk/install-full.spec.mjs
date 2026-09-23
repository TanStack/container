import {test,expect} from '@playwright/test'
import {build} from 'esbuild'
import {readFileSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'

test('diagnostic full pinned Vite project install in plain worker',async({page},info)=>{
  test.skip(info.project.name!=='webkit','WebKit full installer diagnostic')
  const sdk=resolve(process.env.SDK_OUTPUT),example=join(sdk,'examples/frameworks')
  const projectsText=readFileSync(join(example,'projects.json'),'utf8')
  const originalProject=JSON.parse(projectsText).vite
  const {withExampleTests}=await import(pathToFileURL(join(example,'scripts.mjs')).href)
  // Match the example's actual pre-install files, not a filtered package list.
  const project=withExampleTests(originalProject,'vite')
  const lockText=project['/project/package-lock.json']
  expect(typeof lockText).toBe('string')
  const hash=value=>createHash('sha256').update(value).digest('hex')
  const compiled=await build({entryPoints:['tests/sdk/install-full.worker.ts'],bundle:true,write:false,format:'esm',platform:'browser',metafile:true})
  const worker=compiled.outputFiles[0].contents
  const sourceHashes=Object.fromEntries(Object.keys(compiled.metafile.inputs).sort().map(path=>[path,hash(readFileSync(path))]))
  const projectFileHashes=Object.fromEntries(Object.entries(project).sort(([a],[b])=>a.localeCompare(b)).map(([path,text])=>[path,hash(text)]))
  const server=createServer((request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    if(request.url==='/worker.js'){response.setHeader('Content-Type','text/javascript');response.end(worker)}
    else if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Full project install diagnostic</title>')}
    else{response.writeHead(404);response.end()}
  })
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done)})
  const origin='http://127.0.0.1:'+server.address().port
  const events=[],pending=new Map(),errors=[]
  const began=Date.now()
  const record=event=>{events.push({ms:Date.now()-began,...event});if(events.length>512)events.shift()}
  page.on('request',request=>{pending.set(request,request.url());record({type:'request',url:request.url()})})
  page.on('requestfinished',request=>{pending.delete(request);record({type:'finished',url:request.url()})})
  page.on('requestfailed',request=>{pending.delete(request);record({type:'failed',url:request.url(),error:request.failure()?.errorText})})
  page.on('pageerror',error=>{if(errors.length<32)errors.push(String(error))})
  let capability,outcome='not-started'
  try{
    await page.goto(origin)
    capability=await page.evaluate(()=>({crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer==='function'}))
    if(!capability.crossOriginIsolated||!capability.sharedArrayBuffer){outcome='skipped-missing-isolation';test.skip(true,'Shared liveness requires cross-origin isolation and SharedArrayBuffer')}
    await page.evaluate(project=>{
      const state=globalThis.__fullInstall={ownerTicks:0,samples:[],done:false}
      const buffer=new SharedArrayBuffer(4*Int32Array.BYTES_PER_ELEMENT),counters=new Int32Array(buffer)
      const sample=()=>({at:performance.now(),ownerTicks:state.ownerTicks,counters:Array.from(counters,(_,index)=>Atomics.load(counters,index)),visibility:document.visibilityState})
      globalThis.__captureFullInstall=()=>({...state,current:sample()})
      const timer=setInterval(()=>{state.ownerTicks++;state.samples.push(sample());if(state.samples.length>64)state.samples.shift()},1000)
      const worker=new Worker('/worker.js',{type:'module'})
      worker.onmessage=event=>{state.result=event.data;state.done=event.data.done===true}
      worker.onerror=event=>{state.error=event.message;state.done=true}
      worker.onmessageerror=()=>{state.error='worker messageerror';state.done=true}
      globalThis.__disposeFullInstall=()=>{clearInterval(timer);worker.terminate()}
      worker.postMessage({buffer,project})
    },project)
    outcome='running'
    await page.waitForFunction(()=>globalThis.__fullInstall.done,undefined,{timeout:60000})
    const state=await page.evaluate(()=>globalThis.__captureFullInstall())
    expect(state.error).toBeUndefined()
    expect(state.result?.error).toBeUndefined()
    expect(state.result?.result.installed).toBeGreaterThan(0)
    expect(state.result?.vitePresent).toBe(true)
    expect(state.result?.lockUnchanged).toBe(true)
    expect(state.current.counters[0]).toBe(1)
    expect(state.current.counters[2]).toBe(2)
    outcome='installed'
  }catch(error){if(outcome!=='skipped-missing-isolation')outcome='failed';throw error}
  finally{
    let deadline
    const capture=page.evaluate(()=>globalThis.__captureFullInstall?.()).then(state=>({state})).catch(error=>({captureError:String(error)}))
    const captured=await Promise.race([capture,new Promise(done=>{deadline=setTimeout(()=>done({captureError:'Owner evaluation did not respond within 2000 ms'}),2000)})])
    clearTimeout(deadline)
    const path=info.outputPath('install-full.json')
    await writeFile(path,JSON.stringify({diagnosticOnly:true,sdk,origin,outcome,capability,
      manifestSHA256:hash(readFileSync(join(sdk,'manifest.json'))),projectsSHA256:hash(projectsText),
      exampleScriptsSHA256:hash(readFileSync(join(example,'scripts.mjs'))),lockSHA256:hash(lockText),projectFileHashes,
      sourceHashes,workerSHA256:hash(worker),workspace:{maxBytes:128*1024*1024,maxFiles:16384},
      installOptions:{cwd:'/project',ignoreScripts:true},counterNames:['workerAttached','workerTicks','stage','completionSent'],
      stageCodes:{installing:1,installed:2,failed:3},errors,pending:[...pending.values()],events,...captured},null,2))
    await info.attach('install-full.json',{path,contentType:'application/json'})
    await page.close().catch(()=>{})
    server.closeIdleConnections()
    await new Promise(done=>server.close(done))
  }
})
