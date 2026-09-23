import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {transform} from 'esbuild'
import {startNativeStartHost,prepareNativeStartFixture,confinedFile,validateNativeFirefox} from '../scripts/native-firefox-start.mjs'
import {runNativeStart,observeNativeStartReadiness,classifyNavigationCancellations} from '../scripts/native-firefox-start-client.mjs'

test('navigation classification requires every independent cancellation witness',()=>{
  const url='http://localhost/client.tsx',message='TypeError: error loading dynamically imported module: '+url
  const evidence={previewDiagnostics:[message],documentEvents:[{kind:'error',message,documentId:'1',timeOrigin:10,at:100},{kind:'start',documentId:'2',timeOrigin:100.5}],readiness:{documentId:'2',timeOrigin:100.5,seenBootstrap:true,hydrated:true,streamEnded:true},reloads:[{documentId:'1',at:99,protocol:'vite-hmr',payload:{type:'full-reload',path:'*'}}],http:[{documentId:'1',url,startedAt:90,bodyCompletedAt:110,status:200}],completedPreviewRequests:[{pathname:'/client.tsx',status:200},{pathname:'/client.tsx',status:200}]}
  evidence.http.push({documentId:'2',url,startedAt:120,bodyCompletedAt:130,status:200})
  evidence.documentEvents[1].at=110
  assert.equal(classifyNavigationCancellations(evidence).cancellations.length,1)
  assert.deepEqual(classifyNavigationCancellations(evidence).cancellations[0].replacementRequest,evidence.http[1])
  const offset=structuredClone(evidence);offset.documentEvents[0].at=101
  assert.equal(classifyNavigationCancellations(offset).cancellations.length,1)
  for(const mutate of [
    e=>e.documentEvents=[],e=>e.reloads=[],e=>e.http=[],e=>e.completedPreviewRequests=[],
    e=>e.documentEvents[0].documentId='2',e=>e.documentEvents[0].at=90,
    e=>e.documentEvents[0].at=110,e=>e.documentEvents[0].at=111,
    e=>e.documentEvents.push({...e.documentEvents[0],documentId:'2'}),
    e=>e.http[0].url+='?different',e=>e.http[0].status=500,e=>e.http[0].bodyError='aborted',
    e=>e.http[0].bodyCompletedAt=99,e=>e.http[0].startedAt=101,
    e=>e.http.pop(),e=>e.http[1].url+='?different',e=>e.http[1].bodyError='failed',
    e=>e.http[1].status=500,e=>e.http[1].documentId='1',e=>e.http[1].startedAt=99,e=>e.http[1].bodyCompletedAt=119,
    e=>e.readiness.hydrated=false,e=>e.readiness.documentId='3',
    e=>e.reloads[0].protocol='other',e=>e.reloads[0].at=101,e=>e.reloads[0].payload.path='/other.html',
  ]){const copy=structuredClone(evidence);mutate(copy);assert.deepEqual(classifyNavigationCancellations(copy).fatal,[message])}
  const extra=structuredClone(evidence);extra.previewDiagnostics.push('Real application failure')
  assert.deepEqual(classifyNavigationCancellations(extra).fatal,['Real application failure'])
  assert.deepEqual(evidence.previewDiagnostics,[message])
})

test('cleanup is memoized and evidence preserves errors across documents',()=>{
  const driver=runNativeStart.toString(),observer=observeNativeStartReadiness.toString()
  assert.match(driver,/return stopPromise\?\?=cleanup\(\)/)
  assert.match(driver,/completedPreviewRequests=preview.requests.slice\(-256\)/)
  assert.match(driver,/retain\(evidence.documentEvents,event.data,64\)/)
  assert.match(observer,/record\('unhandledrejection',event.reason\)/)
  assert.match(observer,/record\('pagehide'\)/)
  assert.match(observer,/documentId,timeOrigin:performance.timeOrigin,at:Date.now\(\)/)
})

test('cold snapshot captures preview diagnostics before releasing the preview',()=>{
  const driver=runNativeStart.toString()
  assert.match(driver,/evidence\.previewDiagnostics=preview\.diagnostics\.slice\(-32\);preview\.close\(\);preview=undefined/)
  assert.match(driver,/check\(!evidence\.previewClassification.fatal.length,'Preview runtime errors'\)/)
  assert.match(driver,/await stop\(\);verifyClean\(\);await report\('cold',evidence\)/)
  assert.match(driver,/await stop\(\);verifyClean\(\);await report\('result'/)
})

test('native launcher refuses patched Firefox before starting a browser',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-firefox-validation-test-'))
  mkdirSync(join(root,'MacOS'));mkdirSync(join(root,'Resources'))
  const binary=join(root,'MacOS/firefox');writeFileSync(binary,'test-only')
  writeFileSync(join(root,'Resources/application.ini'),'Version=156.0\n')
  assert.equal(validateNativeFirefox(binary).version,'156.0')
  writeFileSync(join(root,'Resources/playwright.cfg'),'// patched browser')
  assert.throws(()=>validateNativeFirefox(binary),/Playwright builds attach Juggler/)
})

test('native acceptance preserves actual source and declared portable graph',()=>{
  const fixture=prepareNativeStartFixture()
  assert.equal(fixture.hashes['package.json'],fixture.provenance.sourceSHA256)
  const manifest=JSON.parse(fixture.files['/project/package.json'])
  assert.equal(manifest.overrides.rolldown,'1.2.9')
  assert.match(fixture.files['/project/src/routes/index.tsx'],/Add 1 to \{state\}\?/)
  assert.match(fixture.files['/project/sdk-acceptance-server.mjs'],/SITE_START_READY/)
  assert.equal(fixture.lockfileSHA256.length,64)
})

test('native host preserves isolation and SDK bytes, protects receiver, applies worker offline CSP',async()=>{
  const root=mkdtempSync(join(tmpdir(),'native-start-host-test-'))
  mkdirSync(join(root,'preview-host'));mkdirSync(join(root,'runtime'))
  const bytes=Buffer.from([0,97,115,109,1,0,0,0])
  writeFileSync(join(root,'manifest.json'),JSON.stringify({buildProfile:'test',experimentalRolldownParser:{},engines:{'quickjs-als-asyncify-wasm-atomics-fibers-shared-storage':{}}}))
  writeFileSync(join(root,'preview-host/hosting.json'),JSON.stringify({routes:[{path:'/__sandbox/bridge.html',method:'GET',file:'bridge.html',headers:{'Content-Type':'text/html'}}],fallbackStatus:404}))
  writeFileSync(join(root,'preview-host/bridge.html'),'<html></html>')
  writeFileSync(join(root,'index.js'),'export const fixture=true;')
  writeFileSync(join(root,'runtime/engine.wasm'),bytes)
  const fixture={files:{'/project/package.json':'{}'},hashes:{},provenance:{},processEnv:{},lockfileSHA256:'test'}
  const host=await startNativeStartHost({sdkRoot:root,fixture})
  const post=(kind,value,token=host.token,origin=host.ownerOrigin)=>fetch(`${host.ownerOrigin}/__test/${kind}?token=${token}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(value)})
  try{
    const owner=await fetch(host.ownerOrigin+'/app/')
    assert.equal(owner.headers.get('cross-origin-opener-policy'),'same-origin')
    assert.equal(owner.headers.get('cross-origin-embedder-policy'),'require-corp')
    assert.equal(owner.headers.get('content-security-policy'),null)
    const bridge=await fetch(host.previewOrigin+'/__sandbox/bridge.html')
    assert.equal(bridge.headers.get('cross-origin-resource-policy'),'cross-origin')
    assert.equal(bridge.headers.get('cross-origin-embedder-policy'),'require-corp')
    const driver=await(await fetch(host.ownerOrigin+'/driver.js')).text()
    await transform(driver,{loader:'js',format:'esm'})
    assert.match(driver,/new sdk.WorkerKernel/)
    assert.match(driver,/failureMessage=error\?\.message/)
    assert.match(driver,/evidence.failure=String\(error\)/)
    assert.doesNotMatch(driver,/Debugger|juggler/)
    assert.equal((await post('result',{},'wrong')).status,403)
    assert.equal((await post('result',{},host.token,'http://example.com')).status,403)
    assert.equal((await post('offline',{})).status,400)
    assert.equal((await post('cold',{saved:{sha256:'test'}})).status,200)
    assert.equal((await post('offline',{})).status,200)
    for(const path of ['/app/','/app/vendor/runtime/engine.wasm']){
      const response=await fetch(host.ownerOrigin+path)
      assert.match(response.headers.get('content-security-policy'),/^connect-src 'self' http:\/\/127\.0\.0\.1:/)
      assert.match(response.headers.get('content-security-policy'),/report-uri \/__test\/csp\?token=/)
      if(path.endsWith('.wasm'))assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes)
    }
    assert.deepEqual((await(await fetch(host.ownerOrigin+'/config.json')).json()).files,{})
    await post('violation',{blockedURI:'https://registry.npmjs.org'})
    await post('result',{passed:true,resumed:true})
    assert.equal((await host.completed).passed,true)
    assert.equal(host.evidence().violations.length,1)
    assert.equal(host.evidence().manifestSHA256.length,64)
    assert.throws(()=>confinedFile(root,'../outside'))
    assert.equal(readFileSync(join(root,'runtime/engine.wasm')).equals(bytes),true)
  }finally{await host.close()}
})
