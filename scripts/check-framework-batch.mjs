import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,readdirSync} from 'node:fs'
import {resolve,join,dirname,basename,isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'

const hash=value=>createHash('sha256').update(value).digest('hex')
const nonempty=value=>typeof value==='string'&&value.length>0
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
function checkBrowsers(browsers){
  assert.ok(Array.isArray(browsers)&&browsers.length===2,'Select exactly two browsers: chromium,webkit or chromium,firefox')
  assert.ok(new Set(browsers).size===2&&browsers.includes('chromium')&&browsers.every(browser=>['chromium','webkit','firefox'].includes(browser)),'Select distinct browsers: chromium,webkit or chromium,firefox, never Safari')
  return browsers
}
export function parseFrameworkBrowsers(value='chromium,webkit'){
  assert.equal(typeof value,'string','Browser selection must be a comma-separated pair')
  return checkBrowsers(value.split(','))
}
function checkNavigation(rows,label){
  assert.ok(Array.isArray(rows),`${label}: missing navigation`)
  assert.deepEqual(rows.map(row=>row.phase),['cold','offline-resumed'],`${label}: incomplete navigation phases`)
  for(const row of rows){
    const where=`${label} ${row.phase}`
    const ids=[row.ownerDocumentId,row.homeDocumentId,row.reloadDocumentId]
    assert.ok(ids.every(nonempty)&&new Set(ids).size===3,`${where}: document identities must be distinct`)
    for(const field of ['ownerTimeOrigin','homeTimeOrigin','reloadTimeOrigin'])assert.ok(Number.isFinite(row[field])&&row[field]>0,`${where}: invalid ${field}`)
    assert.ok(row.homeTimeOrigin>=row.ownerTimeOrigin&&row.reloadTimeOrigin>row.homeTimeOrigin,`${where}: invalid document timing order`)
    assert.equal(row.reloadStatus,200,`${where}: reload failed`)
    assert.equal(row.reloadPath,'/about',`${where}: wrong reload route`)
    assert.equal(row.returnedPath,'/',`${where}: did not return home`)
  }
  assert.notEqual(rows[0].ownerDocumentId,rows[1].ownerDocumentId,`${label}: resume did not reload owner`)
  assert.ok(rows[1].ownerTimeOrigin>rows[0].ownerTimeOrigin,`${label}: resume owner timing did not advance`)
  assert.equal(new Set(rows.flatMap(row=>[row.ownerDocumentId,row.homeDocumentId,row.reloadDocumentId])).size,6,`${label}: reused document identity across resume`)
}

function checkWorkflow(report,observations,label){
  for(const key of ['phases','navigation','offlineExternalRequests','stopped'])assert.deepEqual(report[key],observations[key],`${label}: paired ${key} mismatch`)
  const cold=report.phases?.cold,resume=report.phases?.resume
  assert.ok(cold&&resume,`${label}: cold and resume phase evidence required`)
  for(const [phase,checks] of [[cold,[['initial',0,0],['negative',1,1],['edited',2,0]]],[resume,[['restored',0,0],['edited',1,0]]]]){
    assert.equal(phase.selectedScript,'test',`${label}: wrong selected script`)
    for(const [name,before,status] of checks){
      const result=phase.tests?.[name]
      assert.equal(result?.beforeCount,before,`${label}: ${name} prior completion count mismatch`)
      assert.equal(result?.afterCount,before+1,`${label}: ${name} fresh completion count mismatch`)
      assert.equal(result?.exitStatus,status,`${label}: ${name} exit status mismatch`)
    }
    assert.equal(phase.editedPreviewText,'Edited example',`${label}: edited preview missing`)
  }
  assert.ok(nonempty(cold.ownerDocumentId)&&nonempty(resume.ownerDocumentId),`${label}: owner document identities missing`)
  assert.notEqual(cold.ownerDocumentId,resume.ownerDocumentId,`${label}: resume did not reload owner`)
  assert.equal(resume.newEditPreviewText,'Resumed edit',`${label}: resumed edit missing`)
  assert.deepEqual(report.offlineExternalRequests,[],`${label}: external resume requests`)
  assert.equal(report.stopped?.previewIframeCount,0,`${label}: preview was not stopped`)
  assert.ok(typeof observations.output==='string'&&observations.output.includes('App stopped'),`${label}: completed Stop output missing`)
  assert.equal(cold.previewText,report.kind==='vite'?'Hello from Vite':'Bare-bones Start',`${label}: initial preview missing`)
  if(report.kind==='start'){
    assert.equal(cold.negativeEditVisible,true,`${label}: negative edit missing`)
    for(const [index,phase] of [cold,resume].entries()){
      assert.equal(phase.hydrated,'true',`${label}: Start hydration missing`)
      assert.equal(phase.counterText,'Count: 1',`${label}: Start counter interaction missing`)
      assert.ok(typeof phase.serverReply==='string',`${label}: Start server reply missing`)
      assert.equal(JSON.parse(phase.serverReply).method,'POST',`${label}: Start server POST missing`)
      assert.equal(report.navigation[index].ownerDocumentId,phase.ownerDocumentId,`${label}: navigation owner mismatch`)
    }
  }
}

export function checkFrameworkBatch(sdkDirectory,manifestBytes,entries,browsers=['chromium','webkit'],split){
  checkBrowsers(browsers)
  const names={chromium:'Chromium',webkit:'WebKit',firefox:'Firefox'},browserLabel=browsers.map(browser=>names[browser]).join('/')
  const sdk=resolve(sdkDirectory),manifest=JSON.parse(manifestBytes.toString()),manifestSHA256=hash(manifestBytes)
  const profile=split?JSON.parse(split.runtimeProfileBytes.toString()):manifest
  const runtimeManifestSHA256=split?hash(split.runtimeManifestBytes):undefined
  if(split){
    const runtimeManifest=JSON.parse(split.runtimeManifestBytes.toString())
    assert.equal(manifest.format,1,'Unsupported SDK package manifest')
    assert.equal(runtimeManifest.format,1,'Unsupported runtime package manifest')
    const profileEntry=runtimeManifest.files?.find(file=>file.path==='runtime-profile.json')
    assert.equal(profileEntry?.sha256,hash(split.runtimeProfileBytes),'Runtime profile manifest binding mismatch')
    assert.equal(profileEntry?.bytes,split.runtimeProfileBytes.length,'Runtime profile byte count mismatch')
  }
  assert.ok(nonempty(profile.buildProfile),'Missing SDK build profile')
  assert.equal(entries.length,12,`Exactly twelve runs required: three each Vite/Start on ${browserLabel}`)
  const paths=new Set(),matrix=new Set(),consumers=new Set(),runs=[]
  let tarballSHA256,runtimeTarballSHA256
  for(const {path,report,observationsPath,observations} of entries){
    const label=path
    assert.ok(nonempty(path)&&nonempty(observationsPath),'Missing report paths')
    assert.equal(basename(path),'framework-example.json',`${label}: wrong report artifact`)
    assert.equal(basename(observationsPath),'framework-observations.json',`${label}: wrong observations artifact`)
    assert.equal(dirname(resolve(path)),dirname(resolve(observationsPath)),`${label}: reports are not paired in one run`)
    for(const candidate of [path,observationsPath]){const absolute=resolve(candidate);assert.ok(!paths.has(absolute),`${label}: duplicate report path`);paths.add(absolute)}
    assert.ok(report&&observations,`${label}: missing paired report`)
    assert.equal(observations.status,'passed',`${label}: observations did not pass`)
    assert.deepEqual(observations.errors,[],`${label}: observed page errors`)
    assert.deepEqual(observations.failures,[],`${label}: observed console, HTTP or request failures`)
    assert.deepEqual(observations.pending,[],`${label}: pending requests`)
    assert.ok(Array.isArray(observations.events),`${label}: missing observed events`)
    for(const item of [report,observations]){
      if(split){
        assert.equal(item.packaging,'split',`${label}: expected split packaging`)
        assert.equal(item.buildProfile,profile.buildProfile,`${label}: runtime profile mismatch`)
        assert.equal(item.runtimeManifestSHA256,runtimeManifestSHA256,`${label}: runtime manifest mismatch`)
        assert.ok(digest(item.runtimeTarballSHA256),`${label}: invalid runtime tarball hash`)
        assert.ok(digest(item.deploymentManifestSHA256),`${label}: invalid deployment manifest hash`)
      }else assert.notEqual(item.packaging,'split',`${label}: split evidence requires runtime inputs`)
      assert.ok(!item.diagnosticOnly&&!item.ownedProfile&&!item.standardProfile,`${label}: diagnostic report`)
      assert.equal(item.manifestSHA256,manifestSHA256,`${label}: SDK manifest mismatch`)
      assert.equal(item.sdk,sdk,`${label}: SDK directory mismatch`)
      assert.equal(item.exampleSource,join(sdk,'examples/frameworks'),`${label}: not the packaged example`)
      assert.ok(nonempty(item.directory)&&isAbsolute(item.directory),`${label}: invalid consumer directory`)
      assert.ok(digest(item.tarballSHA256),`${label}: invalid tarball hash`)
    }
    for(const key of ['sdk','exampleSource','directory','manifestSHA256','tarballSHA256'])assert.equal(report[key],observations[key],`${label}: paired ${key} mismatch`)
    if(split){
      for(const key of ['runtimeManifestSHA256','runtimeTarballSHA256','deploymentManifestSHA256'])assert.equal(report[key],observations[key],`${label}: paired ${key} mismatch`)
      if(runtimeTarballSHA256)assert.equal(report.runtimeTarballSHA256,runtimeTarballSHA256,`${label}: batch runtime tarball mismatch`)
      else runtimeTarballSHA256=report.runtimeTarballSHA256
    }
    if(tarballSHA256)assert.equal(report.tarballSHA256,tarballSHA256,`${label}: batch tarball mismatch`)
    else tarballSHA256=report.tarballSHA256
    assert.ok(['vite','start'].includes(report.kind),`${label}: unknown framework`)
    assert.ok(browsers.includes(report.browser),`${label}: browser is outside the selected matrix, this is not Safari evidence`)
    assert.equal(report.actualSafari,false,`${label}: must explicitly exclude Safari`)
    const match=basename(dirname(path)).match(/-(chromium|webkit|firefox)(?:-repeat([12]))?$/)
    assert.ok(match,`${label}: missing explicit browser/repeat identity`)
    assert.equal(match[1],report.browser,`${label}: path browser mismatch`)
    const repeat=Number(match[2]??0),key=`${report.browser}:${report.kind}:${repeat}`
    assert.ok(!matrix.has(key),`${label}: duplicate matrix run`);matrix.add(key)
    const consumer=`${report.browser}:${report.kind}:${report.directory}`
    assert.ok(!consumers.has(consumer),`${label}: reused consumer evidence`);consumers.add(consumer)
    if(report.kind==='start')checkNavigation(report.navigation,label)
    else assert.deepEqual(report.navigation,[],`${label}: unexpected Vite navigation evidence`)
    checkWorkflow(report,observations,label)
    runs.push({path:resolve(path),observationsPath:resolve(observationsPath),kind:report.kind,browser:report.browser,repeat})
  }
  for(const browser of browsers)for(const kind of ['vite','start'])for(let repeat=0;repeat<3;repeat++)assert.ok(matrix.has(`${browser}:${kind}:${repeat}`),`Missing ${browser} ${kind} repeat ${repeat}`)
  return {passed:true,scope:`Packaged Vite/Start workflow on Playwright ${browserLabel} only, not Safari. Page errors, captured console/HTTP/request failures and pending requests are checked. This does not establish byte-exact restore or complete release acceptance.`,sdk,manifestSHA256,buildProfile:profile.buildProfile,tarballSHA256,...(split?{packaging:'split',runtimeManifestSHA256,runtimeTarballSHA256}:{}),runs}
}

export function readFrameworkReports(directory){
  const entries=[]
  function walk(path){
    const children=readdirSync(path,{withFileTypes:true})
    const names=new Set(children.filter(entry=>entry.isFile()).map(entry=>entry.name))
    if(names.has('framework-example.json')||names.has('framework-observations.json')){
      assert.ok(names.has('framework-example.json')&&names.has('framework-observations.json'),`${path}: missing paired report`)
      const reportPath=join(path,'framework-example.json'),observationsPath=join(path,'framework-observations.json')
      entries.push({path:reportPath,observationsPath,report:JSON.parse(readFileSync(reportPath,'utf8')),observations:JSON.parse(readFileSync(observationsPath,'utf8'))})
    }
    for(const child of children)if(child.isDirectory())walk(join(path,child.name))
  }
  walk(resolve(directory));return entries
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  assert.ok([4,5].includes(process.argv.length),'Usage: node scripts/check-framework-batch.mjs SDK_DIRECTORY REPORT_DIRECTORY [chromium,webkit|chromium,firefox]')
  const browsers=parseFrameworkBrowsers(process.argv[4])
  const sdk=resolve(process.argv[2])
  const runtime=process.env.SDK_RUNTIME_OUTPUT
  const split=runtime?{runtimeManifestBytes:readFileSync(join(runtime,'package-assets.json')),runtimeProfileBytes:readFileSync(join(runtime,'runtime-profile.json'))}:undefined
  console.log(JSON.stringify(checkFrameworkBatch(sdk,readFileSync(join(sdk,split?'package-assets.json':'manifest.json')),readFrameworkReports(process.argv[3]),browsers,split),null,2))
}
