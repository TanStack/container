import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {checkFrameworkBatch,parseFrameworkBrowsers} from '../scripts/check-framework-batch.mjs'

const manifest=Buffer.from(JSON.stringify({buildProfile:'experimental-fibers'}))
const manifestSHA256=createHash('sha256').update(manifest).digest('hex')
function fixtures(browsers=['chromium','webkit']){
  const entries=[]
  for(const browser of browsers)for(const kind of ['vite','start'])for(let repeat=0;repeat<3;repeat++){
    const folder=`/reports/example-${kind}-${browser}${repeat?'-repeat'+repeat:''}`
    const evidence={sdk:'/sdk',exampleSource:'/sdk/examples/frameworks',directory:`/consumer/${browser}/${repeat}`,tarballSHA256:'a'.repeat(64),manifestSHA256}
    const navigation=kind==='vite'?[]:['cold','offline-resumed'].map((phase,index)=>({phase,ownerDocumentId:`${folder}-${index}-owner`,homeDocumentId:`${folder}-${index}-home`,reloadDocumentId:`${folder}-${index}-reload`,ownerTimeOrigin:100+index*100,homeTimeOrigin:110+index*100,reloadTimeOrigin:120+index*100,reloadStatus:200,reloadPath:'/about',returnedPath:'/'}))
    const result=(beforeCount,exitStatus)=>({beforeCount,afterCount:beforeCount+1,exitStatus})
    const start=kind==='start'?{hydrated:'true',counterText:'Count: 1',serverReply:'{"method":"POST"}'}:{}
    const phases={cold:{...start,ownerDocumentId:`${folder}-0-owner`,selectedScript:'test',previewText:kind==='vite'?'Hello from Vite':'Bare-bones Start',editedPreviewText:'Edited example',negativeEditVisible:true,tests:{initial:result(0,0),negative:result(1,1),edited:result(2,0)}},resume:{...start,ownerDocumentId:`${folder}-1-owner`,selectedScript:'test',editedPreviewText:'Edited example',newEditPreviewText:'Resumed edit',tests:{restored:result(0,0),edited:result(1,0)}}}
    const workflow={kind,browser,actualSafari:false,navigation,phases,offlineExternalRequests:[],stopped:{previewIframeCount:0}}
    entries.push({path:folder+'/framework-example.json',observationsPath:folder+'/framework-observations.json',report:{...evidence,...structuredClone(workflow)},observations:{...evidence,...structuredClone(workflow),status:'passed',output:'App stopped\n',errors:[],failures:[],pending:[],events:[]}})
  }
  return entries
}
const check=entries=>checkFrameworkBatch('/sdk',manifest,entries)
test('split batch binds both packages and runtime profile without accepting legacy evidence',()=>{
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
  const core=Buffer.from(JSON.stringify({format:1,files:[]}))
  const runtimeProfileBytes=manifest
  const runtimeManifestBytes=Buffer.from(JSON.stringify({format:1,files:[{path:'runtime-profile.json',bytes:manifest.length,sha256:digest(manifest)}]}))
  const split={runtimeProfileBytes,runtimeManifestBytes}
  const entries=fixtures()
  for(const entry of entries)for(const item of [entry.report,entry.observations])Object.assign(item,{packaging:'split',buildProfile:'experimental-fibers',manifestSHA256:digest(core),runtimeManifestSHA256:digest(runtimeManifestBytes),runtimeTarballSHA256:'c'.repeat(64),deploymentManifestSHA256:'d'.repeat(64)})
  const run=values=>checkFrameworkBatch('/sdk',core,values,['chromium','webkit'],split)
  assert.equal(run(entries).passed,true)
  assert.throws(()=>checkFrameworkBatch('/sdk',core,entries),/build profile/)
  for(const field of ['packaging','buildProfile','runtimeManifestSHA256','runtimeTarballSHA256','deploymentManifestSHA256']){
    const changed=structuredClone(entries);delete changed[0].observations[field]
    assert.throws(()=>run(changed),field)
  }
  const changed=structuredClone(entries)
  changed[0].observations.deploymentManifestSHA256='e'.repeat(64)
  assert.throws(()=>run(changed),/paired deployment/)
  const mixed=structuredClone(entries)
  for(const item of [mixed[0].report,mixed[0].observations])item.runtimeTarballSHA256='e'.repeat(64)
  assert.throws(()=>run(mixed),/batch runtime/)
  assert.throws(()=>checkFrameworkBatch('/sdk',core,entries,['chromium','webkit'],{...split,runtimeProfileBytes:Buffer.from('{}')}),/profile manifest binding/)
})
test('accepts an explicit Chromium/Firefox matrix without changing the default',()=>{
  const browsers=parseFrameworkBrowsers('chromium,firefox'),entries=fixtures(browsers),before=structuredClone(entries)
  const result=checkFrameworkBatch('/sdk',manifest,entries,browsers)
  assert.equal(result.passed,true);assert.equal(result.runs.length,12)
  assert.match(result.scope,/Chromium\/Firefox only, not Safari/)
  assert.deepEqual(entries,before)
  assert.throws(()=>check(entries),/outside the selected matrix/)
  assert.throws(()=>checkFrameworkBatch('/sdk',manifest,fixtures(),browsers),/outside the selected matrix/)
  assert.throws(()=>checkFrameworkBatch('/sdk',manifest,entries.slice(1),browsers),/twelve/)
  entries[6].report.browser='chromium'
  assert.throws(()=>checkFrameworkBatch('/sdk',manifest,entries,browsers),/path browser mismatch/)
})
test('rejects invalid browser selections in API and CLI parsing',()=>{
  assert.deepEqual(parseFrameworkBrowsers(),['chromium','webkit'])
  assert.deepEqual(parseFrameworkBrowsers('chromium,webkit'),['chromium','webkit'])
  for(const value of ['',',','chromium','chromium,','chromium,chromium','chromium,safari','chromium,unknown','firefox,webkit','chromium,webkit,firefox',' chromium,firefox']){
    assert.throws(()=>parseFrameworkBrowsers(value),value)
    assert.throws(()=>checkFrameworkBatch('/sdk',manifest,fixtures(),value.split(',')),value)
  }
  for(const value of [null,{},'chromium,firefox'])assert.throws(()=>checkFrameworkBatch('/sdk',manifest,fixtures(),value))
})
test('accepts exact three-repeat framework matrix without mutating evidence',()=>{
  const entries=fixtures(),before=structuredClone(entries),result=check(entries)
  assert.equal(result.passed,true);assert.equal(result.runs.length,12)
  assert.equal(result.manifestSHA256,manifestSHA256)
  assert.match(result.scope,/not Safari/);assert.match(result.scope,/captured console\/HTTP\/request failures/)
  assert.deepEqual(entries,before)
})
test('rejects missing, duplicate, failed, diagnostic, or mismatched reports',()=>{
  assert.throws(()=>check(fixtures().slice(1)),/twelve/)
  const mutations=[
    entries=>entries.push(structuredClone(entries[0])),
    entries=>entries[1]=structuredClone(entries[0]),
    entries=>entries[0].path='/reports/renamed.json',
    entries=>entries[0].observationsPath='/other/framework-observations.json',
    entries=>delete entries[0].observations,
    entries=>entries[0].observations.status='failed',
    entries=>entries[0].observations.errors=['page failed'],
    entries=>delete entries[0].observations.failures,
    ...['console-error','console-warning','http-error','failed'].map(type=>entries=>entries[0].observations.failures=[{type}]),
    entries=>entries[0].observations.pending=[{url:'http://pending'}],
    entries=>delete entries[0].observations.events,
    ...['report','observations'].flatMap(field=>[
      entries=>entries[0][field].diagnosticOnly=true,
      entries=>entries[0][field].ownedProfile={diagnosticOnly:true},
      entries=>entries[0][field].standardProfile={diagnosticOnly:true},
      entries=>entries[0][field].manifestSHA256='b'.repeat(64),
      entries=>entries[0][field].sdk='/different-sdk',
      entries=>entries[0][field].exampleSource='/source/examples/sdk-frameworks',
      entries=>entries[0][field].tarballSHA256='bad',
      entries=>entries[0][field].directory='relative',
    ]),
    entries=>entries[0].observations.directory='/another-consumer',
    entries=>{entries[0].report.tarballSHA256='c'.repeat(64);entries[0].observations.tarballSHA256='c'.repeat(64)},
    entries=>entries[0].report.kind='unknown',
    entries=>entries[0].report.browser='firefox',
    entries=>entries[0].report.browser='webkit',
    entries=>entries[0].report.actualSafari=true,
    entries=>delete entries[0].report.actualSafari,
    entries=>{entries[1].report.directory=entries[0].report.directory;entries[1].observations.directory=entries[0].report.directory},
    entries=>{entries[1].path='/other/example-vite-chromium/framework-example.json';entries[1].observationsPath='/other/example-vite-chromium/framework-observations.json'},
  ]
  for(const mutate of mutations){const entries=fixtures();mutate(entries);assert.throws(()=>check(entries),mutate.toString())}
})
test('rejects incomplete or contradictory Start navigation',()=>{
  const mutations=[
    rows=>rows.pop(),rows=>rows.reverse(),rows=>rows[1].phase='cold',
    rows=>delete rows[0].ownerDocumentId,rows=>rows[0].reloadDocumentId=rows[0].homeDocumentId,
    rows=>rows[0].homeDocumentId=rows[0].ownerDocumentId,
    rows=>rows[0].reloadStatus=404,rows=>rows[0].reloadPath='/',rows=>rows[0].returnedPath='/about',
    rows=>rows[0].ownerTimeOrigin=0,rows=>rows[0].homeTimeOrigin=1,rows=>rows[0].reloadTimeOrigin=rows[0].homeTimeOrigin,
    rows=>rows[1].ownerDocumentId=rows[0].ownerDocumentId,
    rows=>rows[1].ownerTimeOrigin=rows[0].ownerTimeOrigin,
    rows=>rows[1].homeDocumentId=rows[0].homeDocumentId,
  ]
  for(const mutate of mutations){const entries=fixtures();mutate(entries.find(entry=>entry.report.kind==='start').report.navigation);assert.throws(()=>check(entries),mutate.toString())}
})

test('rejects historical or stale script evidence even when paired reports agree',()=>{
  const mutations=[
    report=>delete report.phases,
    report=>delete report.phases.resume,
    report=>delete report.phases.cold.tests,
    report=>delete report.phases.resume.tests.edited,
    ...[['cold','initial',0,0],['cold','negative',1,1],['cold','edited',2,0],['resume','restored',0,0],['resume','edited',1,0]].flatMap(([phase,name,before,status])=>[
      report=>delete report.phases[phase].tests[name].beforeCount,
      report=>delete report.phases[phase].tests[name].afterCount,
      report=>report.phases[phase].tests[name].beforeCount=before+1,
      report=>report.phases[phase].tests[name].afterCount=before,
      report=>report.phases[phase].tests[name].afterCount=before+2,
      report=>report.phases[phase].tests[name].exitStatus=status===0?1:0,
    ]),
  ]
  for(const mutate of mutations){
    const entries=fixtures()
    for(const key of ['report','observations'])mutate(entries[0][key])
    assert.throws(()=>check(entries),mutate.toString())
  }
})

test('requires paired phases, actual resumed edits, offline requests and completed Stop',()=>{
  for(const key of ['phases','navigation','offlineExternalRequests','stopped']){
    const entries=fixtures();delete entries[0].observations[key]
    assert.throws(()=>check(entries),/paired .* mismatch/)
  }
  const mutations=[
    report=>delete report.phases.resume.newEditPreviewText,
    report=>report.phases.resume.newEditPreviewText='Edited example',
    report=>report.phases.cold.previewText='wrong',
    ...['cold','resume'].flatMap(phase=>[
      report=>report.phases[phase].editedPreviewText='wrong',
      report=>report.phases[phase].selectedScript='build',
      report=>delete report.phases[phase].ownerDocumentId,
    ]),
    report=>report.phases.resume.ownerDocumentId=report.phases.cold.ownerDocumentId,
    report=>delete report.offlineExternalRequests,
    report=>report.offlineExternalRequests=['https://registry.npmjs.org/package'],
    report=>delete report.stopped,
    report=>report.stopped.previewIframeCount=1,
  ]
  for(const mutate of mutations){const entries=fixtures();for(const key of ['report','observations'])mutate(entries[0][key]);assert.throws(()=>check(entries),mutate.toString())}
  for(const output of [undefined,'Preview detached','']){const entries=fixtures();entries[0].observations.output=output;assert.throws(()=>check(entries),/completed Stop output missing/)}
})

test('requires retained Start hydration, counter and POST interaction evidence',()=>{
  const mutations=[report=>delete report.phases.cold.negativeEditVisible,
    ...['cold','resume'].flatMap(phase=>[
      report=>delete report.phases[phase].hydrated,
      report=>report.phases[phase].hydrated='false',
      report=>report.phases[phase].counterText='Count: 0',
      report=>delete report.phases[phase].serverReply,
      report=>report.phases[phase].serverReply='{"method":"GET"}',
      report=>report.phases[phase].serverReply='not JSON',
      report=>report.phases[phase].ownerDocumentId='other-owner',
    ]),
  ]
  for(const mutate of mutations){const entries=fixtures(),entry=entries.find(row=>row.report.kind==='start');for(const key of ['report','observations'])mutate(entry[key]);assert.throws(()=>check(entries),mutate.toString())}
})
