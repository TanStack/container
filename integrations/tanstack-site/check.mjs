import {chromium} from '@playwright/test'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {acceptanceConfig,isolationHeaders,publicHTTPSURL,verifyDeployedIdentity} from './acceptance-mode.mjs'

const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const acceptance=acceptanceConfig()
const ownerUrl=acceptance.ownerUrl.href
const ownerOrigin=acceptance.ownerUrl.origin
const reportPath=resolve(repositoryRoot,process.env.SDK_INTEGRATION_REPORT??'reports/tanstack-site-QA3oVl-acceptance.json')
const sha256=value=>createHash('sha256').update(value).digest('hex')
const browser=await chromium.launch({headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
const started=performance.now(),timings={}
const pageErrors=[],consoleErrors=[],blockedTelemetryErrors=[],httpErrors=[],externalRequests=[],blockedExternalRequests=[]
const report={
  schemaVersion:1,
  workflow:'TanStack.com Start counter through the standalone browser sandbox SDK',
  result:'failed',
  startedAt:new Date().toISOString(),
  browser:{name:'Chromium',version:browser.version()},
  acceptanceMode:acceptance.mode,
  ownerUrl,
  ...(acceptance.previewOrigin?{previewOrigin:acceptance.previewOrigin}:{}),
  workflowEvidence:Object.fromEntries(['GITHUB_ACTIONS','GITHUB_WORKFLOW','GITHUB_WORKFLOW_REF','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_REF','GITHUB_REPOSITORY'].flatMap(name=>process.env[name]?[[name,process.env[name]]]:[])),
}
const responseEvidence=[]
let recordExternalRequests=false
const mark=name=>{timings[name]=Math.round((performance.now()-started)*1000)/1000}
const bounded=(promise,label,timeoutMs=10000)=>{
  let timer
  return Promise.race([
    promise,
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} exceeded its ${timeoutMs}ms host deadline`)),timeoutMs)}),
  ]).finally(()=>clearTimeout(timer))
}
await page.addInitScript(expectedOrigin=>{
  if(window===top||location.pathname!=='/'||(expectedOrigin&&location.origin!==expectedOrigin))return
  let bootstrap
  const sample=()=>{
    const current=window.$_TSR
    if(current&&typeof current.h==='function')bootstrap=current
    window.__sdkStartReady=bootstrap?.hydrated===true&&bootstrap?.streamEnded===true
  }
  const observer=new MutationObserver(sample)
  observer.observe(document,{childList:true,subtree:true})
  const timer=setInterval(sample,20)
  const stop=()=>{observer.disconnect();clearInterval(timer)}
  addEventListener('pagehide',stop,{once:true})
  setTimeout(stop,30000)
  sample()
},acceptance.previewOrigin??null)
page.on('pageerror',error=>{pageErrors.push(String(error));console.log('PAGE_ERROR',String(error))})
await page.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url())
  if(url.hostname.endsWith('.ingest.us.sentry.io')){
    blockedExternalRequests.push({url:request.url(),resourceType:request.resourceType()})
    return route.abort('blockedbyclient')
  }
  return route.continue()
})
page.on('console',message=>{if(message.type()==='error'){
  const text=message.text()
  if(text.includes('ERR_BLOCKED_BY_CLIENT')&&blockedExternalRequests.length){blockedTelemetryErrors.push(text);return}
  consoleErrors.push(text);console.log('CONSOLE_ERROR',text)
}})
page.on('requestfailed',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/__sandbox'))console.log('REQUEST_FAILED',url.origin+url.pathname,request.failure()?.errorText)})
page.on('request',request=>{
  if(!recordExternalRequests)return
  const url=new URL(request.url())
  if(url.origin===ownerOrigin||url.origin===acceptance.previewOrigin||url.protocol==='data:'||url.protocol==='blob:')return
  let owner='worker'
  try { owner=request.frame().url() } catch {}
  externalRequests.push({url:request.url(),owner,resourceType:request.resourceType()})
})
page.on('response',response=>{if(response.status()>=400){httpErrors.push(`${response.status()} ${response.url()}`);console.log('HTTP_ERROR',response.status(),response.url())}})
page.on('response',response=>{
  if(response.request().resourceType()!=='document')return
  const headers=response.headers()
  responseEvidence.push({url:response.url(),status:response.status(),isolationHeaders:isolationHeaders(headers)})
})
try {
  report.sdk={}
  if(process.env.SDK_MANIFEST){
    const manifestBytes=await readFile(resolve(process.env.SDK_MANIFEST))
    const manifest=JSON.parse(manifestBytes.toString('utf8'))
    Object.assign(report.sdk,{manifest:{path:resolve(process.env.SDK_MANIFEST),sha256:sha256(manifestBytes)},buildProfile:manifest.buildProfile})
    if(process.env.SDK_MANIFEST_SHA256&&report.sdk.manifest.sha256!==process.env.SDK_MANIFEST_SHA256)throw Error(`SDK manifest SHA256 mismatch: expected ${process.env.SDK_MANIFEST_SHA256}, received ${report.sdk.manifest.sha256}`)
  }
  if(process.env.SDK_TARBALL){
    const tarballBytes=await readFile(resolve(process.env.SDK_TARBALL))
    report.sdk.tarball={path:resolve(process.env.SDK_TARBALL),sha256:sha256(tarballBytes),bytes:tarballBytes.byteLength}
    if(process.env.SDK_TARBALL_SHA256&&report.sdk.tarball.sha256!==process.env.SDK_TARBALL_SHA256)throw Error(`SDK tarball SHA256 mismatch: expected ${process.env.SDK_TARBALL_SHA256}, received ${report.sdk.tarball.sha256}`)
  }
  report.sdk.artifactBound=acceptance.mode==='deployed'||Boolean(process.env.SDK_MANIFEST&&process.env.SDK_MANIFEST_SHA256&&process.env.SDK_TARBALL&&process.env.SDK_TARBALL_SHA256)
  const ownerResponse=await page.goto(ownerUrl,{timeout:120000,waitUntil:'domcontentloaded'})
  if(!ownerResponse)throw Error('Owner navigation did not return a response')
  report.deployment={requestedUrl:ownerUrl,url:page.url(),status:ownerResponse.status(),isolationHeaders:isolationHeaders(ownerResponse.headers())}
  if(acceptance.mode==='deployed'){
    publicHTTPSURL(page.url(),'Final deployment URL')
    if(ownerResponse.status()<200||ownerResponse.status()>=400)throw Error(`Deployed owner returned HTTP ${ownerResponse.status()}`)
    const headers=report.deployment.isolationHeaders
    if(headers['cross-origin-opener-policy']!=='same-origin')throw Error('Deployed owner must return Cross-Origin-Opener-Policy: same-origin')
    if(!['require-corp','credentialless'].includes(headers['cross-origin-embedder-policy']))throw Error('Deployed owner must return a cross-origin isolation policy')
  }
  mark('ownerDomContentLoadedMs')
  if(acceptance.mode==='local')await page.getByText('Local SDK, portable dependencies',{exact:true}).waitFor({timeout:120000})
  const run=page.getByRole('button',{name:'Run',exact:true})
  await run.waitFor()
  mark('panelReadyMs')
  console.log('LOCAL_PANEL_READY')
  await run.click({timeout:30000})
  mark('runClickedMs')
  const frame=page.frameLocator('[aria-label$=" preview"] iframe')
  await Promise.race([
    frame.getByRole('button',{name:'Add 1 to 0?',exact:true}).waitFor({timeout:120000}),
    page.getByRole('alert').waitFor({timeout:120000}).then(async()=>{throw Error(await page.getByRole('alert').innerText())}),
  ])
  mark('ssrVisibleMs')
  const preview=await (await page.locator('[aria-label$=" preview"] iframe').elementHandle()).contentFrame()
  await preview.waitForFunction(()=>window.__sdkStartReady===true,undefined,{timeout:30000})
  mark('hydratedMs')
  console.log('HYDRATION_PASSED')
  mark('firstServerFunctionStartedMs')
  await frame.getByRole('button',{name:'Add 1 to 0?',exact:true}).click()
  await frame.getByRole('button',{name:'Add 1 to 1?',exact:true}).waitFor()
  mark('firstServerFunctionMs')
  const projectResponse=await page.request.get(new URL('/__sandbox-local/project.json',ownerOrigin).href)
  if(!projectResponse.ok())throw Error(`SDK project identity endpoint returned HTTP ${projectResponse.status()}`)
  const project=await projectResponse.json()
  report.projectIdentity=project.identity
  if(acceptance.mode==='deployed')report.sdk.publishedPackage=verifyDeployedIdentity(project.identity,acceptance)
  else if(report.sdk.manifest&&project.identity?.sdkManifestSHA256!==report.sdk.manifest.sha256)throw Error(`TanStack.com selected SDK manifest ${project.identity?.sdkManifestSHA256}, expected ${report.sdk.manifest.sha256}`)
  const source=project.files['/project/src/routes/index.tsx']
  if(!source.includes('Add 1 to {state}?')) throw Error('Live-edit marker changed')
  mark('liveEditStartedMs')
  await page.locator('.cm-content[contenteditable="true"]').fill(source.replace('Add 1 to {state}?','SDK edit {state}?'))
  await frame.getByRole('button',{name:'SDK edit 1?',exact:true}).waitFor({timeout:30000})
  mark('liveEditRenderedMs')
  mark('secondServerFunctionStartedMs')
  await frame.getByRole('button',{name:'SDK edit 1?',exact:true}).click()
  await frame.getByRole('button',{name:'SDK edit 2?',exact:true}).waitFor()
  mark('secondServerFunctionMs')
  console.log('LIVE_EDIT_PASSED')
  console.log('SERVER_FUNCTION_PASSED')
  await page.locator('.cm-content[contenteditable="true"]').fill(source.replace('Add 1 to {state}?','Saved edit {state}?'))
  mark('saveStartedMs')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  await page.getByRole('status').filter({hasText:'Saved'}).waitFor({timeout:60000})
  if(await page.locator('[aria-label$=" preview"] iframe').count()!==0)throw Error('Save left the preview attached')
  const persisted=await page.evaluate(async()=>{
    const open=(name,version)=>new Promise((resolve,reject)=>{const request=indexedDB.open(name,version);request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result)})
    const metadataDatabase=await open('tanstack-browser-sandbox',3)
    const records=await new Promise((resolve,reject)=>{const transaction=metadataDatabase.transaction('saved-workspace-metadata','readonly');const request=transaction.objectStore('saved-workspace-metadata').getAll();transaction.onabort=()=>reject(transaction.error);transaction.oncomplete=()=>resolve(request.result)})
    metadataDatabase.close()
    const value=records[0],checkpointKey=value?.checkpoint?.key
    const checkpointDatabase=await open('tanstack-sandbox-spike',4)
    const checkpoint=await new Promise((resolve,reject)=>{const transaction=checkpointDatabase.transaction(['checkpoint-manifests','checkpoint-blobs'],'readonly');const manifestRequest=transaction.objectStore('checkpoint-manifests').get(checkpointKey);const blobCountRequest=transaction.objectStore('checkpoint-blobs').count();transaction.onabort=()=>reject(transaction.error);transaction.oncomplete=()=>resolve({manifest:manifestRequest.result,storedBlobs:blobCountRequest.result})})
    checkpointDatabase.close()
    const manifest=checkpoint.manifest,paths=Object.keys(manifest?.entries??{})
    return {records:records.length,projectId:value?.projectId,version:value?.version,checkpoint:value?.checkpoint,storedBlobs:checkpoint.storedBlobs,manifestKey:manifest?.key,snapshotVersion:manifest?.snapshotVersion,files:manifest?.files,bytes:manifest?.bytes,chunks:manifest?.chunks,packageFiles:paths.filter(path=>path.startsWith('/project/node_modules/')).length,hasSource:paths.includes('/project/src/routes/index.tsx'),hasCount:paths.includes('/project/count.txt')}
  })
  if(persisted.records!==1||persisted.version!==1||persisted.manifestKey!==`tanstack-example:${persisted.projectId}`||persisted.checkpoint?.key!==persisted.manifestKey||persisted.snapshotVersion!==5||persisted.files<1||persisted.bytes<1||persisted.chunks<1||persisted.storedBlobs!==persisted.chunks||persisted.packageFiles<1||!persisted.hasSource||!persisted.hasCount)throw Error('Worker-owned checkpoint did not preserve the workspace: '+JSON.stringify(persisted))
  mark('savedMs')
  console.log('SAVE_PASSED',JSON.stringify({snapshotVersion:persisted.snapshotVersion,files:persisted.files,bytes:persisted.bytes,chunks:persisted.chunks,packageFiles:persisted.packageFiles}))
  console.log('READING_TIME_ORIGIN')
  const firstTimeOrigin=await page.evaluate(()=>performance.timeOrigin)
  console.log('RELOADING_OWNER',firstTimeOrigin)
  await page.reload({timeout:120000,waitUntil:'domcontentloaded'})
  console.log('OWNER_RELOADED')
  if(acceptance.mode==='local')await page.getByText('Local SDK, portable dependencies',{exact:true}).waitFor({timeout:120000})
  const secondTimeOrigin=await page.evaluate(()=>performance.timeOrigin)
  if(secondTimeOrigin===firstTimeOrigin)throw Error('Owner page did not create a new document')
  const resume=page.getByRole('button',{name:'Resume',exact:true})
  await resume.waitFor()
  if(await resume.isDisabled())throw Error('Compatible saved workspace is not resumable after reload')
  console.log('RESUME_READY')
  recordExternalRequests=true
  mark('resumeStartedMs')
  await bounded(resume.click({trial:true,timeout:5000}),'Resume actionability')
  console.log('RESUME_ACTIONABLE')
  await bounded(resume.click({noWaitAfter:true,timeout:5000}),'Resume click')
  console.log('RESUME_CLICKED')
  const resumedFrame=page.frameLocator('[aria-label$=" preview"] iframe')
  await Promise.race([
    resumedFrame.getByRole('button',{name:'Saved edit 2?',exact:true}).waitFor({timeout:120000}),
    page.getByRole('alert').waitFor({timeout:120000}).then(async()=>{throw Error(await page.getByRole('alert').innerText())}),
  ])
  const resumedOutput=await page.getByLabel('Process output').innerText()
  if(!resumedOutput.includes('Restored saved workspace without installing dependencies.'))throw Error('Resume did not report snapshot restoration')
  if(resumedOutput.includes('Installed '))throw Error('Resume unexpectedly installed dependencies')
  const dependencyRequests=externalRequests.filter(request=>(request.owner==='worker'||Boolean(acceptance.previewOrigin&&request.owner.startsWith(acceptance.previewOrigin)))&&!/\.Inspector(?:\?|$)/.test(request.url))
  report.offlineResume={dependencyRequests}
  if(dependencyRequests.length)throw Error('Resume requested external dependencies: '+JSON.stringify(dependencyRequests))
  await page.locator('.cm-content[contenteditable="true"]').filter({hasText:'Saved edit {state}?'}).waitFor({timeout:30000})
  const resumedPreview=await (await page.locator('[aria-label$=" preview"] iframe').elementHandle()).contentFrame()
  await resumedPreview.waitForFunction(()=>window.__sdkStartReady===true,undefined,{timeout:30000})
  mark('resumedMs')
  await resumedFrame.getByRole('button',{name:'Saved edit 2?',exact:true}).click()
  await resumedFrame.getByRole('button',{name:'Saved edit 3?',exact:true}).waitFor()
  await page.locator('.cm-content[contenteditable="true"]').fill(source.replace('Add 1 to {state}?','Resumed edit {state}?'))
  await resumedFrame.getByRole('button',{name:'Resumed edit 3?',exact:true}).waitFor({timeout:30000})
  await resumedFrame.getByRole('button',{name:'Resumed edit 3?',exact:true}).click()
  await resumedFrame.getByRole('button',{name:'Resumed edit 4?',exact:true}).waitFor()
  mark('resumedInteractionMs')
  console.log('RESUME_PASSED')
  await page.screenshot({path:'/private/tmp/tanstack-sdk-integration/resumed.png',fullPage:true})
  await page.getByRole('button',{name:'Stop',exact:true}).click()
  await page.getByRole('status').filter({hasText:'Stopped'}).waitFor({timeout:30000})
  if(await page.locator('[aria-label$=" preview"] iframe').count()!==0)throw Error('Stop left the preview attached')
  mark('stoppedMs')
  if(pageErrors.length||consoleErrors.length||httpErrors.length)throw Error('Browser errors observed: '+JSON.stringify({pageErrors,consoleErrors,httpErrors}))
  report.result='passed'
  report.workspace={snapshotVersion:persisted.snapshotVersion,files:persisted.files,bytes:persisted.bytes,chunks:persisted.chunks,packageFiles:persisted.packageFiles}
  console.log('TIMINGS',JSON.stringify(timings))
  console.log('STOPPED',0)
} catch(error) {
  report.error=String(error)
  console.log('FAILURE',String(error))
  console.log('BODY',await page.locator('body').innerText().catch(()=>''))
  await page.screenshot({path:'/private/tmp/tanstack-sdk-integration/failure.png',fullPage:true}).catch(()=>{})
  process.exitCode=1
} finally {
  report.finishedAt=new Date().toISOString()
  report.responseEvidence=responseEvidence
  report.timings=timings
  report.diagnostics={pageErrors,consoleErrors,blockedTelemetryErrors,httpErrors,externalRequests,blockedExternalRequests}
  await mkdir(dirname(reportPath),{recursive:true})
  await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`)
  console.log('REPORT',reportPath)
  await browser.close()
}
