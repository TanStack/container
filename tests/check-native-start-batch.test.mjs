import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {checkNativeStartBatch} from '../scripts/check-native-start-batch.mjs'
import {classifyNavigationCancellations} from '../scripts/native-firefox-start-client.mjs'

const manifest=Buffer.from(JSON.stringify({buildProfile:'experimental-fibers'}))
const hash=createHash('sha256').update(manifest).digest('hex')
function fixtures(){
  const phase=resumed=>({resumed,crossOriginIsolated:true,errors:[],stages:[resumed?'restored files, dependencies and optimizer cache without install':'installed portable graph','SSR','hydrated','HMR without owner reload','server functions and filesystem verified'],ssr:{status:200,expected:resumed?'Increment 2?':'Add 1 to 0?'},readiness:{documentId:'1',timeOrigin:10,seenBootstrap:true,hydrated:true,streamEnded:true},parserAfterSSR:{completedCalls:1,failedCalls:0,callable:{completed:1,failed:0}},resources:{processes:{active:0},nativeParser:{failedCalls:0,callable:{failed:0}}},shutdownAcknowledged:true,previewDiagnostics:[],documentEvents:[],http:[],reloads:[],completedPreviewRequests:[],previewClassification:{cancellations:[],fatal:[]}})
  return [1,2,3].map(index=>{
    const cold=phase(false),result=phase(true),saved={sha256:'a'.repeat(64),files:10,bytes:1000,packageFiles:8,cacheFiles:2}
    cold.install={installed:3};cold.saved=saved;result.restored=structuredClone(saved);result.passed=true
    return {path:`/reports/run${index}.json`,report:{passed:true,manifestSHA256:hash,buildProfile:'experimental-fibers',sourceHashes:{'package.json':'b'.repeat(64),'src/route.tsx':'c'.repeat(64)},lockfileSHA256:'d'.repeat(64),provenance:{source:'start-counter',graphChanges:{dependencies:{vite:'8.0.0'}}},browser:{binary:'/browser/firefox',version:'156',profile:`/profiles/fresh${index}`,args:['-no-remote','-headless','-profile',`/profiles/fresh${index}`]},offline:true,violations:[],cold,result,stages:[...cold.stages.map(name=>({name,resumed:false})),...result.stages.map(name=>({name,resumed:true}))]}}
  })
}
test('accepts three distinct complete runs without changing report inputs',()=>{
  const entries=fixtures(),before=structuredClone(entries),result=checkNativeStartBatch(manifest,entries)
  assert.equal(result.passed,true);assert.equal(result.runs.length,3)
  assert.deepEqual(result.runs[0].expectedNavigationCancellations,{cold:0,resume:0})
  assert.deepEqual(entries,before)
})
test('rejects incomplete, mismatched, reused, or failed evidence',()=>{
  assert.throws(()=>checkNativeStartBatch(manifest,fixtures().slice(0,2)),/three/)
  const mutations=[
    e=>e[1].path=e[0].path,e=>e[1].report.browser.profile=e[0].report.browser.profile,
    e=>e[1].report.browser.version='other',e=>e[1].report.browser.binary='/other',e=>e[1].report.browser.args.push('--remote-debugging-port=1'),
    e=>e[0].report.manifestSHA256='wrong',e=>e[0].report.buildProfile='wrong',e=>e[0].report.passed=false,
    e=>delete e[0].report.sourceHashes,e=>e[0].report.sourceHashes={},e=>e[0].report.sourceHashes['package.json']='invalid',
    e=>e[1].report.sourceHashes['src/route.tsx']='e'.repeat(64),
    e=>delete e[0].report.lockfileSHA256,e=>e[0].report.lockfileSHA256='invalid',e=>e[1].report.lockfileSHA256='e'.repeat(64),
    e=>delete e[0].report.provenance,e=>e[0].report.provenance={},e=>e[1].report.provenance.graphChanges.dependencies.vite='other',
    e=>e[0].report.failure='failed',e=>e[0].report.offline=false,e=>e[0].report.violations.push('network'),
    e=>e[0].report.cold.stages.pop(),e=>e[0].report.stages.pop(),e=>e[0].report.result.passed=false,
    e=>e[0].report.result.restored.sha256='b'.repeat(64),e=>e[0].report.cold.saved.cacheFiles=0,
    e=>e[0].report.cold.install.installed=0,e=>e[0].report.result.install={installed:1},
    ...['cold','result'].flatMap(phase=>[
      e=>e[0].report[phase].errors.push('owner error'),e=>e[0].report[phase].drainError='drain',e=>e[0].report[phase].cleanupError='cleanup',
      e=>e[0].report[phase].resources.processes.active=1,e=>e[0].report[phase].shutdownAcknowledged=false,
      e=>e[0].report[phase].resources.nativeParser.failedCalls=1,e=>e[0].report[phase].resources.nativeParser.callable.failed=1,
      e=>e[0].report[phase].parserAfterSSR.completedCalls=0,e=>e[0].report[phase].readiness.hydrated=false,
      e=>e[0].report[phase].previewDiagnostics.push('application failure'),e=>e[0].report[phase].documentEvents.push({kind:'error',message:'unreported error'}),
      e=>e[0].report[phase].http.push({bodyError:'broken'}),
    ]),
  ]
  for(const mutate of mutations){const entries=fixtures();mutate(entries);assert.throws(()=>checkNativeStartBatch(manifest,entries),mutate.toString())}
})
test('recomputes exact cancellation witnesses and retains expected counts',()=>{
  const entries=fixtures(),phase=entries[0].report.cold,url='http://localhost/client.tsx',message='TypeError: error loading dynamically imported module: '+url
  Object.assign(phase,{previewDiagnostics:[message],documentEvents:[{kind:'error',message,documentId:'1',timeOrigin:10,at:100},{kind:'start',documentId:'2',timeOrigin:100.5,at:110}],readiness:{documentId:'2',timeOrigin:100.5,seenBootstrap:true,hydrated:true,streamEnded:true},reloads:[{documentId:'1',at:99,protocol:'vite-hmr',payload:{type:'full-reload',path:'*'}}],http:[{documentId:'1',url,startedAt:90,bodyCompletedAt:110,status:200},{documentId:'2',url,startedAt:120,bodyCompletedAt:130,status:200}],completedPreviewRequests:[{pathname:'/client.tsx',status:200},{pathname:'/client.tsx',status:200}]})
  phase.previewClassification=classifyNavigationCancellations(phase)
  assert.equal(checkNativeStartBatch(manifest,entries).runs[0].expectedNavigationCancellations.cold,1)
  const tampered=structuredClone(entries);tampered[0].report.cold.http.pop()
  assert.throws(()=>checkNativeStartBatch(manifest,tampered),/unclassified/)
  phase.previewClassification.cancellations=[]
  assert.throws(()=>checkNativeStartBatch(manifest,entries),/classification differs/)
})
