import {test as base,expect} from '@playwright/test'
import {mkdtempSync,cpSync,readFileSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {tmpdir,platform,release,arch} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {withOwnedWebKitProfile,ownedWebKitEvidence,ownedProfileEnabled,standardProfileEnabled,captureStandardWebKitOwnership,standardWebKitEvidence} from './helpers/owned-webkit-fixture.mjs'
import {traceFrameworkOwner} from './helpers/trace-framework-owner.mjs'
import {traceFrameworkScheduler} from './helpers/trace-framework-scheduler.mjs'
import {guestStreamTracePrelude} from './helpers/trace-framework-streams.mjs'
import {parseFrameworkScriptResults,extractFreshFrameworkScriptResult} from './helpers/framework-script-result.mjs'

const test=withOwnedWebKitProfile(base)

let host,evidence
const observations=new WeakMap()
const captureModules=process.env.SDK_CAPTURE_PREVIEW_MODULES==='1'
const traceOwner=process.env.SDK_TRACE_OWNER_REQUESTS==='1'
const traceUTF8=process.env.SDK_TRACE_UTF8==='1'
const traceScheduling=process.env.SDK_TRACE_WORKER_SCHEDULING==='1'
test.beforeEach(async({page,browser,playwright,browserName})=>{
  evidence.environment={browser:browserName,browserVersion:browser.version(),platform:platform(),release:release(),architecture:arch(),node:process.version}
  await captureStandardWebKitOwnership(browser,playwright,browserName)
  await page.addInitScript(()=>{
    Object.defineProperty(document,'__frameworkDocumentId',{value:crypto.randomUUID()})
  })
  if(captureModules)await page.addInitScript(()=>{
    if(location.pathname!=='/__sandbox/bridge.html')return
    const requests=globalThis.__frameworkBridgeRequests=[]
    navigator.serviceWorker.addEventListener('message',event=>{
      if(event.data?.type==='request'&&requests.length<512)
        requests.push({url:event.data.url,method:event.data.method,at:performance.timeOrigin+performance.now()})
    })
  })
  const started=Date.now(),pending=new Map(),events=[],errors=[]
  const modules=[],moduleReads=new Set(),failures=[]
  let moduleBytes=0,moduleCaptureLimited=false
  if(captureModules)page.on('response',response=>{
    if(!response.url().startsWith(host.previewOrigin+'/'))return
    const type=response.headers()['content-type']??''
    // Keep error responses too, even when the bridge returns plain text.
    if(!/javascript|text\/html/.test(type)&&response.status()<400&&!/\.(?:[cm]?js|tsx?)(?:\?|$)/.test(response.url()))return
    if(modules.length+moduleReads.size>=512||moduleBytes>=16*1024*1024){moduleCaptureLimited=true;return}
    const read=response.text().then(body=>{
      const bytes=Buffer.byteLength(body)
      if(bytes>2*1024*1024||moduleBytes+bytes>16*1024*1024){moduleCaptureLimited=true;return}
      moduleBytes+=bytes
      modules.push({url:response.url(),status:response.status(),type,ms:Date.now()-started,sha256:createHash('sha256').update(body).digest('hex'),body})
    }).catch(error=>{modules.push({url:response.url(),error:String(error)})}).finally(()=>moduleReads.delete(read))
    moduleReads.add(read)
  })
  const record=entry=>{const timed={ms:Date.now()-started,...entry};events.push(timed);if(events.length>256)events.shift();if(/error|failed|warning/.test(entry.type)&&failures.length<256)failures.push(timed)}
  page.on('request',request=>{pending.set(request,{url:request.url(),ms:Date.now()-started});record({type:'request',url:request.url()})})
  page.on('requestfinished',request=>{pending.delete(request);record({type:'finished',url:request.url()})})
  page.on('requestfailed',request=>{pending.delete(request);record({type:'failed',url:request.url(),error:request.failure()?.errorText})})
  page.on('response',response=>{if(response.status()>=400)record({type:'http-error',url:response.url(),status:response.status()})})
  page.on('pageerror',error=>{errors.push(String(error));if(errors.length>32)errors.shift()})
  page.on('console',message=>{if(['error','warning'].includes(message.type()))record({type:'console-'+message.type(),text:message.text(),location:message.location()})})
  observations.set(page,{pending,events,errors,failures,modules,moduleReads,captureLimited:()=>moduleCaptureLimited})
})
test.afterEach(async({page,browser},info)=>{
  // Sample before page/context/browser teardown, only after a real workflow
  // failure. This never changes the workflow outcome or retries it.
  const ownedProfile=await ownedWebKitEvidence(browser,info.status!==info.expectedStatus)
  const standardProfile=await standardWebKitEvidence(browser,info.status!==info.expectedStatus)
  const observed=observations.get(page)
  if(!observed)return
  const output=await page.locator('#output').textContent({timeout:1000}).catch(()=>null)
  let previewFailure=null
  if(info.status!==info.expectedStatus){
    const previewElement=await page.locator('#preview iframe').elementHandle({timeout:1000}).catch(()=>null)
    const preview=await previewElement?.contentFrame()
    if(preview){
      let timer
      try{
        previewFailure=await Promise.race([
          preview.evaluate(()=>({
            url:location.href,readyState:document.readyState,
            hydrated:document.querySelector('main')?.getAttribute('data-hydrated'),
            observedReadiness:globalThis.__frameworkStartReadiness??null,
            reactPreambleInstalled:globalThis.__vite_plugin_react_preamble_installed__===true,
            startOptionsInstalled:Object.hasOwn(globalThis,'__TSS_START_OPTIONS__'),
            bootstrap:globalThis.$_TSR?{hydrated:globalThis.$_TSR.hydrated,streamEnded:globalThis.$_TSR.streamEnded,keys:Object.keys(globalThis.$_TSR)}:null,
            resources:performance.getEntriesByType('resource').slice(-12).map(entry=>({name:entry.name,duration:entry.duration,responseEnd:entry.responseEnd})),
          })),
          new Promise(resolve=>{timer=setTimeout(()=>resolve({observationTimedOut:true}),1000)}),
        ])
      }catch(error){previewFailure={observationError:String(error)}}
      finally{clearTimeout(timer)}
    }
    await previewElement?.dispose()
  }
  const path=info.outputPath('framework-observations.json')
  let ownerTrace=null
  if(traceOwner){
    let timer
    try{ownerTrace=await Promise.race([page.evaluate(async()=>{const trace=globalThis.__frameworkOwnerTrace;let timer;try{return {requests:trace?.requests,resources:await Promise.race([trace?.resources(),new Promise(resolve=>{timer=setTimeout(()=>resolve({observationTimedOut:true}),500)})])}}finally{clearTimeout(timer)}}),new Promise(resolve=>{timer=setTimeout(()=>resolve({observationTimedOut:true}),1000)})])}
    catch(error){ownerTrace={error:String(error)}}finally{clearTimeout(timer)}
    try{
      const optimizer=await Promise.race([page.evaluate(()=>globalThis.__frameworkOwnerTrace?.optimizer()),new Promise(resolve=>{timer=setTimeout(()=>resolve({observationTimedOut:true}),2000)})])
      ownerTrace={...ownerTrace,optimizer}
    }catch(error){ownerTrace={...ownerTrace,optimizer:{error:String(error)}}}finally{clearTimeout(timer)}
  }
  const schedulerTrace=traceScheduling?await page.evaluate(()=>{
    const kernel=globalThis.__frameworkSchedulerKernel
    return {samples:kernel?.schedulerDiagnostics??[],lifecycle:kernel?.workerLifecycle??[],guestSamples:kernel?.guestSamples??[],guestSamplesDropped:kernel?.guestSamplesDropped??0,guestSamplesOwnerDropped:kernel?.guestSamplesOwnerDropped??0,guestSamplingErrors:kernel?.guestSamplingErrors??[]}
  }).catch(error=>({error:String(error)})):undefined
  await writeFile(path,JSON.stringify({...evidence,...observed.workflow,ownedProfile,standardProfile,status:info.status,output,previewFailure,ownerTrace,schedulerTrace,errors:observed.errors,failures:observed.failures,pending:[...observed.pending.values()].slice(-256),events:observed.events},null,2))
  await info.attach('framework-observations.json',{path,contentType:'application/json'})
  if(captureModules){
    let timer
    try{await Promise.race([Promise.allSettled([...observed.moduleReads]),new Promise(resolve=>{timer=setTimeout(resolve,2000)})])}
    finally{clearTimeout(timer)}
    const modulesPath=info.outputPath('framework-modules.json')
    const bridge=page.frames().find(frame=>new URL(frame.url()||'about:blank').pathname==='/__sandbox/bridge.html')
    let bridgeRequests=null
    try{bridgeRequests=await Promise.race([bridge?.evaluate(()=>globalThis.__frameworkBridgeRequests??null).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve({observationTimedOut:true}),1000)})])}
    finally{clearTimeout(timer)}
    await writeFile(modulesPath,JSON.stringify({...evidence,diagnosticOnly:true,captureLimited:observed.captureLimited(),pendingReads:observed.moduleReads.size,bridgeRequests,modules:observed.modules},null,2))
    await info.attach('framework-modules.json',{path:modulesPath,contentType:'application/json'})
  }
})
test.beforeAll(async()=>{
  const sdk=resolve(process.env.SDK_OUTPUT)
  const directory=mkdtempSync(join(tmpdir(),'sdk-framework-consumer-'))
  const exampleSource=process.env.SDK_FRAMEWORK_EXAMPLE_SOURCE==='1'?resolve('examples/sdk-frameworks'):join(sdk,'examples/frameworks')
  cpSync(exampleSource,join(directory,'example'),{recursive:true})
  let utf8TraceSourceSHA256
  if(traceUTF8){
    const path=join(directory,'example/projects.json'),projects=JSON.parse(readFileSync(path,'utf8'))
    const prelude=`
      const originalEncode=globalThis.__webContainerHost.encodeUTF8;
      const retained=[];
      globalThis.__webContainerHost.encodeUTF8=function(text){
        for(const entry of retained){
          const view=new Uint8Array(entry.buffer);
          const mismatch=view.findIndex((byte,index)=>byte!==entry.expected[index]);
          if(mismatch!==-1)throw Error('UTF8_RETAINED '+JSON.stringify({prefix:entry.prefix,mismatch,actual:view[mismatch],expected:entry.expected[mismatch]}));
        }
        const buffer=originalEncode(text),view=new Uint8Array(buffer);
        if(typeof text==='string'&&text.length<65536&&/^[\\x00-\\x7f]*$/.test(text)){
          if(view.length!==text.length)throw Error('UTF8_LENGTH '+view.length+' '+text.length);
          for(let i=0;i<text.length;i++)if(view[i]!==text.charCodeAt(i))throw Error('UTF8_IMMEDIATE '+JSON.stringify({prefix:text.slice(0,100),index:i,actual:view[i],expected:text.charCodeAt(i)}));
          if(text.includes('self.$R')||text.includes('$tsr-stream-barrier')){
            console.log('UTF8_BARRIER '+JSON.stringify({prefix:text.slice(0,100),length:text.length}));
            if(retained.length<16)retained.push({buffer,expected:Array.from(view),prefix:text.slice(0,100)});
          }
        }
        return buffer;
      };
    `
    projects.start['/project/server.mjs']=prelude+projects.start['/project/server.mjs']
    const source=JSON.stringify(projects)
    await writeFile(path,source)
    utf8TraceSourceSHA256=createHash('sha256').update(source).digest('hex')
  }
  let ownerTraceSourceSHA256
  if(traceOwner){
    const path=join(directory,'example/client.js'),source=traceFrameworkOwner(readFileSync(path,'utf8'))
    await writeFile(path,source)
    ownerTraceSourceSHA256=createHash('sha256').update(source).digest('hex')
  }
  let schedulerTraceSourceSHA256,streamTraceSourceSHA256
  if(traceScheduling){
    const clientPath=join(directory,'example/client.js')
    const client=traceFrameworkScheduler(readFileSync(clientPath,'utf8'))
    await writeFile(clientPath,client)
    schedulerTraceSourceSHA256=createHash('sha256').update(client).digest('hex')
    const projectsPath=join(directory,'example/projects.json')
    const projects=JSON.parse(readFileSync(projectsPath,'utf8'))
    projects.start['/project/server.mjs']=guestStreamTracePrelude+projects.start['/project/server.mjs']
    const projectSource=JSON.stringify(projects)
    await writeFile(projectsPath,projectSource)
    streamTraceSourceSHA256=createHash('sha256').update(projectSource).digest('hex')
  }
  const env={...process.env,npm_config_cache:join(directory,'npm-cache'),npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'}
  const packed=JSON.parse(execFileSync('npm',['pack',sdk,'--json','--ignore-scripts','--pack-destination',directory],{encoding:'utf8',env,timeout:30000}))
  expect(packed).toHaveLength(1)
  const tarball=join(directory,packed[0].filename)
  const runtimeRoot=process.env.SDK_RUNTIME_OUTPUT&&resolve(process.env.SDK_RUNTIME_OUTPUT)
  let runtimeTarball
  if(runtimeRoot){
    const packedRuntime=JSON.parse(execFileSync('npm',['pack',runtimeRoot,'--json','--ignore-scripts','--pack-destination',directory],{encoding:'utf8',env,timeout:30000}))
    expect(packedRuntime).toHaveLength(1)
    runtimeTarball=join(directory,packedRuntime[0].filename)
  }
  execFileSync('npm',['install',...(runtimeRoot?[]:['--offline']),'--ignore-scripts','--no-audit','--no-fund',tarball,...(runtimeTarball?[runtimeTarball]:[])],{cwd:join(directory,'example'),env,timeout:30000})
  const {startExample}=await import(pathToFileURL(join(directory,'example/server.mjs')).href)
  host=await startExample({ownerPort:0,previewPort:0})
  const manifestBytes=readFileSync(join(sdk,runtimeRoot?'package-assets.json':'manifest.json'))
  const buildProfile=runtimeRoot?JSON.parse(readFileSync(join(runtimeRoot,'runtime-profile.json'),'utf8')).buildProfile:JSON.parse(manifestBytes).buildProfile
  evidence={format:1,sdk,directory,exampleSource,buildProfile,tarballSHA256:createHash('sha256').update(readFileSync(tarball)).digest('hex'),manifestSHA256:createHash('sha256').update(manifestBytes).digest('hex')}
  if(runtimeRoot){
    expect(host.preparedAssets?.manifestPath).toBeTruthy()
    evidence.packaging='split'
    evidence.runtimeTarballSHA256=createHash('sha256').update(readFileSync(runtimeTarball)).digest('hex')
    evidence.runtimeManifestSHA256=createHash('sha256').update(readFileSync(join(runtimeRoot,'package-assets.json'))).digest('hex')
    evidence.deploymentManifestSHA256=createHash('sha256').update(readFileSync(host.preparedAssets.manifestPath)).digest('hex')
  }
  evidence.testSourceSHA256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
  evidence.scriptResultHelperSHA256=createHash('sha256').update(readFileSync(new URL('./helpers/framework-script-result.mjs',import.meta.url))).digest('hex')
  evidence.dependencyLockSHA256=createHash('sha256').update(readFileSync('package-lock.json')).digest('hex')
  if(ownedProfileEnabled||standardProfileEnabled||captureModules||traceOwner||traceUTF8||traceScheduling)evidence.diagnosticOnly=true
  if(traceScheduling)Object.assign(evidence,{schedulerTraceSourceSHA256,streamTraceSourceSHA256})
  if(traceUTF8)evidence.utf8TraceSourceSHA256=utf8TraceSourceSHA256
  if(traceOwner)evidence.ownerTraceSourceSHA256=ownerTraceSourceSHA256
})
test.afterAll(async()=>{await host?.close()})

async function checkStartNavigation(page,homeTitle,phase){
  const ownerDocumentId=await page.evaluate(()=>document.__frameworkDocumentId)
  expect(typeof ownerDocumentId).toBe('string')
  const ownerTimeOrigin=await page.evaluate(()=>performance.timeOrigin)
  const iframe=await page.locator('#preview iframe').elementHandle()
  const preview=await iframe.contentFrame()
  expect(preview).not.toBeNull()
  const homeTimeOrigin=await preview.evaluate(()=>performance.timeOrigin)
  const homeDocumentId=await preview.evaluate(()=>document.__frameworkDocumentId)
  expect(typeof homeDocumentId).toBe('string')
  await preview.locator('#about-link').click()
  await expect(preview.locator('#about-title')).toHaveText('Second route')
  expect(new URL(preview.url()).pathname).toBe('/about')
  expect(await preview.evaluate(()=>document.__frameworkDocumentId)).toBe(homeDocumentId)
  const [response]=await Promise.all([
    preview.waitForNavigation({waitUntil:'domcontentloaded'}),
    preview.evaluate(()=>location.reload()),
  ])
  expect(response?.status()).toBe(200)
  expect(new URL(response.url()).pathname).toBe('/about')
  await expect(preview.locator('#about-title')).toHaveText('Second route')
  const reloadTimeOrigin=await preview.evaluate(()=>performance.timeOrigin)
  const reloadDocumentId=await preview.evaluate(()=>document.__frameworkDocumentId)
  expect(typeof reloadDocumentId).toBe('string')
  expect(reloadDocumentId).not.toBe(homeDocumentId)
  await preview.waitForFunction(()=>globalThis.__frameworkStartReadiness?.hydrated&&globalThis.__frameworkStartReadiness?.streamEnded,undefined,{timeout:30000})
  await preview.locator('#home-link').click()
  await expect(preview.locator('h1')).toHaveText(homeTitle)
  await expect(preview.locator('main')).toHaveAttribute('data-hydrated','true')
  expect(new URL(preview.url()).pathname).toBe('/')
  expect(await preview.evaluate(()=>document.__frameworkDocumentId)).toBe(reloadDocumentId)
  expect(await page.evaluate(()=>document.__frameworkDocumentId)).toBe(ownerDocumentId)
  return {phase,ownerDocumentId,homeDocumentId,reloadDocumentId,ownerTimeOrigin,homeTimeOrigin,reloadTimeOrigin,reloadStatus:response.status(),reloadPath:'/about',returnedPath:'/'}
}

for(const kind of ['vite','start'])test('external framework example '+kind+' edits and resumes',async({page,context},info)=>{
  test.setTimeout(240000)
  const navigation=[]
  const cold={tests:{}},resume={tests:{}},blocked=[]
  const workflow={kind,browser:info.project.name,actualSafari:false,phases:{cold,resume},navigation,offlineExternalRequests:blocked}
  observations.get(page).workflow=workflow
  const runScript=async expected=>{
    const beforeCount=parseFrameworkScriptResults(await page.locator('#output').textContent()).length
    await page.locator('#run-script').click()
    let result
    await expect.poll(async()=>{
      const output=await page.locator('#output').textContent()
      try{result=extractFreshFrameworkScriptResult(output,beforeCount);return true}catch{return false}
    },{timeout:30000,message:'A new script invocation must complete'}).toBe(true)
    expect(result.exitStatus).toBe(expected)
    return {...result,beforeCount,afterCount:beforeCount+1}
  }
  await page.addInitScript(({origin})=>{
    if(location.origin!==origin)return
    let bootstrap
    const state=globalThis.__frameworkStartReadiness={hydrated:false,streamEnded:false}
    const sample=()=>{
      if(globalThis.$_TSR?.h)bootstrap=globalThis.$_TSR
      state.hydrated=bootstrap?.hydrated===true
      state.streamEnded=bootstrap?.streamEnded===true
    }
    const observer=new MutationObserver(sample)
    observer.observe(document,{childList:true,subtree:true})
    const timer=setInterval(sample,20)
    const stop=()=>{observer.disconnect();clearInterval(timer)}
    addEventListener('pagehide',stop,{once:true});setTimeout(stop,30000);sample()
  },{origin:host.previewOrigin})
  await page.goto(host.ownerOrigin)
  cold.ownerDocumentId=await page.evaluate(()=>document.__frameworkDocumentId)
  await page.locator('#project').selectOption(kind)
  await page.locator('#open').click()
  const frame=page.frameLocator('#preview iframe')
  if(kind==='vite')await expect(frame.locator('#message')).toHaveText('Hello from Vite',{timeout:60000})
  else{
    await expect(frame.locator('main')).toHaveAttribute('data-hydrated','true',{timeout:60000})
    cold.hydrated=await frame.locator('main').getAttribute('data-hydrated')
    await frame.locator('#start-count').click()
    await expect(frame.locator('#start-count')).toHaveText('Count: 1')
    cold.counterText=await frame.locator('#start-count').textContent()
    await frame.locator('#server-call').click()
    await expect(frame.locator('#server-reply')).toContainText('"method":"POST"')
    cold.serverReply=await frame.locator('#server-reply').textContent()
    navigation.push(await checkStartNavigation(page,'Bare-bones Start','cold'))
  }
  cold.previewText=await frame.locator(kind==='vite'?'#message':'h1').textContent()
  const before=await page.locator('#source').inputValue()
  await expect(page.locator('#script')).toHaveValue('test')
  cold.selectedScript=await page.locator('#script').inputValue()
  cold.tests.initial=await runScript(0)
  await page.locator('#source').fill(kind==='vite'?'export const message = "";':before.replace('id="start-count"','id="removed"'))
  if(kind==='start'){
    await page.locator('#apply').click()
    await expect(frame.locator('#removed')).toBeVisible({timeout:60000})
    cold.negativeEditVisible=await frame.locator('#removed').isVisible()
  }
  cold.tests.negative=await runScript(1)
  await page.locator('#source').fill(before.replace(kind==='vite'?'Hello from Vite':'Bare-bones Start','Edited example'))
  await page.locator('#apply').click()
  await expect(frame.locator(kind==='vite'?'#message':'h1')).toHaveText('Edited example',{timeout:60000})
  cold.editedPreviewText=await frame.locator(kind==='vite'?'#message':'h1').textContent()
  cold.tests.edited=await runScript(0)
  await page.locator('#preview').scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath(kind+'-example.png'),fullPage:true})
  await page.locator('#save').click()
  await expect(page.locator('#output')).toContainText('Saved.')
  cold.saveOutput=await page.locator('#output').textContent()
  await context.route('**/*',async route=>{const origin=new URL(route.request().url()).origin;if(![host.ownerOrigin,host.previewOrigin].includes(origin)){blocked.push(route.request().url());await route.abort()}else await route.continue()})
  await page.reload()
  resume.ownerDocumentId=await page.evaluate(()=>document.__frameworkDocumentId)
  expect(typeof cold.ownerDocumentId).toBe('string')
  expect(typeof resume.ownerDocumentId).toBe('string')
  expect(resume.ownerDocumentId).not.toBe(cold.ownerDocumentId)
  await page.locator('#project').selectOption(kind)
  await page.locator('#resume').click()
  await expect(frame.locator(kind==='vite'?'#message':'h1')).toHaveText('Edited example',{timeout:60000})
  resume.editedPreviewText=await frame.locator(kind==='vite'?'#message':'h1').textContent()
  await expect(page.locator('#script')).toHaveValue('test')
  resume.selectedScript=await page.locator('#script').inputValue()
  resume.tests.restored=await runScript(0)
  if(kind==='start'){
    await expect(frame.locator('main')).toHaveAttribute('data-hydrated','true',{timeout:60000})
    resume.hydrated=await frame.locator('main').getAttribute('data-hydrated')
    await frame.locator('#start-count').click()
    await expect(frame.locator('#start-count')).toHaveText('Count: 1')
    resume.counterText=await frame.locator('#start-count').textContent()
    await frame.locator('#server-call').click()
    await expect(frame.locator('#server-reply')).toContainText('"method":"POST"')
    resume.serverReply=await frame.locator('#server-reply').textContent()
    navigation.push(await checkStartNavigation(page,'Edited example','offline-resumed'))
  }
  await page.locator('#source').fill(before.replace(kind==='vite'?'Hello from Vite':'Bare-bones Start','Resumed edit'))
  await page.locator('#apply').click()
  await expect(frame.locator(kind==='vite'?'#message':'h1')).toHaveText('Resumed edit',{timeout:60000})
  resume.newEditPreviewText=await frame.locator(kind==='vite'?'#message':'h1').textContent()
  resume.tests.edited=await runScript(0)
  await page.locator('#stop').click()
  await expect(page.locator('#output')).toContainText('App stopped',{timeout:30000})
  await expect(page.locator('#preview iframe')).toHaveCount(0)
  workflow.stopped={previewIframeCount:await page.locator('#preview iframe').count()}
  expect(blocked).toEqual([])
  const path=info.outputPath('framework-example.json')
  await writeFile(path,JSON.stringify({...evidence,...workflow},null,2))
  await info.attach('framework-example.json',{path,contentType:'application/json'})
})
