import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {SDK_BROWSER_KEYS,SDK_PHASE_KEYS,SDK_WORKFLOW_KEYS,writeSDKReleaseRecords} from '../scripts/sdk-release-record.mjs'
import {auditSDKCandidateEvidence} from '../scripts/audit-sdk-candidate-evidence.mjs'

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sdk-release-record-'))
  writeFileSync(join(root,'manifest.json'),JSON.stringify({buildProfile:'sync-o2'}))
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'example',version:'0.0.0',private:true}))
  return root
}

test('defaults every candidate browser workflow cell to unverified',()=>{
  const root=fixture(),result=writeSDKReleaseRecords(root)
  const expectedHash=createHash('sha256').update(readFileSync(join(root,'manifest.json'))).digest('hex')
  assert.equal(result.compatibility.artifact.manifestSHA256,expectedHash)
  assert.equal(result.compatibility.artifact.buildProfile,'sync-o2')
  assert.equal(result.compatibility.historicalEvidence.appliedToCandidate,false)
  assert.equal(result.compatibility.browsers.safari.kind,'Actual Safari desktop')
  assert.equal(result.compatibility.browsers['playwright-webkit'].notSafariEvidence,true)
  for(const browser of SDK_BROWSER_KEYS)for(const workflow of SDK_WORKFLOW_KEYS)for(const phase of SDK_PHASE_KEYS)assert.deepEqual(result.compatibility.results[browser][workflow][phase],{status:'unverified'})
  assert.deepEqual(result.release.publication,{published:false,registry:null,tarballSHA256:null})
  assert.deepEqual(result.release.source,{kind:'unavailable',revision:null,archive:null})
})

test('binds the candidate to the exact source archive bytes',()=>{
  const root=fixture(),archive=join(root,'source.tar.gz'),bytes=Buffer.from('snapshot')
  writeFileSync(archive,bytes)
  const result=writeSDKReleaseRecords(root,{sourceArchive:archive}),sha256=createHash('sha256').update(bytes).digest('hex')
  assert.deepEqual(result.release.source,{kind:'source-archive',revision:`sha256:${sha256}`,archive:{file:'source.tar.gz',sha256,bytes:bytes.length}})
})

test('accepts only explicit evidence bound to the exact candidate',()=>{
  const root=fixture(),manifestSHA256=createHash('sha256').update(readFileSync(join(root,'manifest.json'))).digest('hex')
  const evidence=join(root,'evidence.json')
  writeFileSync(evidence,JSON.stringify({format:1,manifestSHA256,buildProfile:'sync-o2',results:{chromium:{vite:{cold:{status:'failed',evidence:['result.json']}}}}}))
  const result=writeSDKReleaseRecords(root,{evidencePath:evidence,evidenceRoot:root})
  assert.deepEqual(result.compatibility.results.chromium.vite.cold,{status:'failed',evidence:['result.json']})
  assert.deepEqual(result.compatibility.results.firefox.vite.cold,{status:'unverified'})
  writeFileSync(evidence,JSON.stringify({format:1,manifestSHA256:'0'.repeat(64),buildProfile:'sync-o2',results:{}}))
  assert.throws(()=>writeSDKReleaseRecords(root,{evidencePath:evidence}),/manifest mismatch/)
})

test('rejects pass or failure claims without evidence',()=>{
  const root=fixture(),manifestSHA256=createHash('sha256').update(readFileSync(join(root,'manifest.json'))).digest('hex'),evidence=join(root,'evidence.json')
  writeFileSync(evidence,JSON.stringify({format:1,manifestSHA256,buildProfile:'sync-o2',results:{safari:{start:{resume:{status:'passed'}}}}}))
  assert.throws(()=>writeSDKReleaseRecords(root,{evidencePath:evidence}),/Missing evidence/)
})

test('rejects a repeated-workflow claim below its declared cycle minimum',()=>{
  const root=fixture(),manifestSHA256=createHash('sha256').update(readFileSync(join(root,'manifest.json'))).digest('hex')
  const evidence=join(root,'evidence.json')
  writeFileSync(evidence,JSON.stringify({
    format:1,manifestSHA256,buildProfile:'sync-o2',minimumCycles:{start:3},
    results:{chromium:{start:{cold:{status:'passed',evidence:[
      'cycle-1/sdk-start-diagnostics.json','cycle-1/sdk-engine-evidence.json',
      'cycle-2/sdk-start-diagnostics.json','cycle-2/sdk-engine-evidence.json',
    ]}}}},
  }))
  assert.throws(()=>writeSDKReleaseRecords(root,{evidencePath:evidence,evidenceRoot:root}),/Need 3 independent evidence cycles.*found 2/)
})

test('accepts actual Safari evidence only when every repeated workflow phase passed',()=>{
  const root=fixture(),manifestSHA256=createHash('sha256').update(readFileSync(join(root,'manifest.json'))).digest('hex')
  const reportName='safari-framework-acceptance-fixture.json',report=join(root,reportName),evidence=join(root,'evidence.json')
  const phase=()=>({status:'passed',evidence:['verified']})
  const results=()=>({vite:{cold:phase(),resume:phase()},start:{cold:phase(),resume:phase()}})
  writeFileSync(report,JSON.stringify({passed:true,actualSafari:true,method:'W3C WebDriver through /usr/bin/safaridriver',browser:{name:'Safari',version:'26.6.2'},artifact:{manifestSHA256,buildProfile:'sync-o2',tarballSHA256:'a'.repeat(64)},requiredRepetitions:3,rounds:[1,2,3].map(index=>({index,results:results()})),results:results()}))
  const safariResult={status:'passed',evidence:[reportName]}
  writeFileSync(evidence,JSON.stringify({format:1,manifestSHA256,buildProfile:'sync-o2',minimumCycles:{vite:3,start:3},results:{safari:{vite:{cold:safariResult,resume:safariResult},start:{cold:safariResult,resume:safariResult}}}}))
  const accepted=writeSDKReleaseRecords(root,{evidencePath:evidence,evidenceRoot:root})
  assert.equal(accepted.compatibility.results.safari.start.resume.status,'passed')
  const failed=JSON.parse(readFileSync(report));failed.rounds[2].results.start.resume.status='failed';writeFileSync(report,JSON.stringify(failed))
  assert.throws(()=>writeSDKReleaseRecords(root,{evidencePath:evidence,evidenceRoot:root}),/Safari start\/resume failed in round 3/)
})

test('accepts candidate-specific TanStack integration evidence',()=>{
  const root=fixture(),manifestSHA256=createHash('sha256').update(readFileSync(join(root,'manifest.json'))).digest('hex')
  const reportName='tanstack-site-final-candidate-acceptance.json',report=join(root,reportName),evidence=join(root,'evidence.json'),tarballSHA256='b'.repeat(64)
  writeFileSync(report,JSON.stringify({
    result:'passed',browser:{name:'Chromium'},
    sdk:{artifactBound:true,manifest:{sha256:manifestSHA256},buildProfile:'sync-o2',tarball:{sha256:tarballSHA256}},
    projectIdentity:{sdkManifestSHA256:manifestSHA256},workspace:{files:10,packageFiles:4},offlineResume:{dependencyRequests:[]},
    diagnostics:{pageErrors:[],consoleErrors:[],httpErrors:[],blockedExternalRequests:[],blockedTelemetryErrors:[]},
    timings:{runClickedMs:1,ssrVisibleMs:2,hydratedMs:3,savedMs:4,resumeStartedMs:5,resumedMs:6,resumedInteractionMs:7,stoppedMs:8},
  }))
  writeFileSync(evidence,JSON.stringify({format:1,manifestSHA256,buildProfile:'sync-o2',integration:{status:'passed',browser:'chromium',evidence:reportName,tarballSHA256},results:{}}))
  const accepted=writeSDKReleaseRecords(root,{evidencePath:evidence,evidenceRoot:root})
  assert.equal(accepted.release.artifact.manifestSHA256,manifestSHA256)
  const reused=JSON.parse(readFileSync(evidence))
  reused.results={chromium:{vite:{cold:{status:'passed',evidence:[reportName]}}}}
  writeFileSync(evidence,JSON.stringify(reused))
  assert.throws(()=>auditSDKCandidateEvidence(root,evidence,root),/integration evidence used for vite/)
})

test('validates a shared engine report against every claimed browser',()=>{
  const root=fixture(),manifestSHA256=createHash('sha256').update(readFileSync(join(root,'manifest.json'))).digest('hex')
  const reportName='sdk-engine-evidence.json',evidence=join(root,'evidence.json')
  writeFileSync(join(root,reportName),JSON.stringify({manifestSHA256,buildProfile:'sync-o2',errors:[],loads:[{}],environment:{project:'chromium',actualSafari:false}}))
  const result={status:'passed',evidence:[reportName]}
  const input={format:1,manifestSHA256,buildProfile:'sync-o2',results:{chromium:{vite:{cold:result,resume:result},start:{cold:result,resume:result}}}}
  writeFileSync(evidence,JSON.stringify(input))
  assert.equal(auditSDKCandidateEvidence(root,evidence,root).files.length,1)
  input.results['playwright-webkit']={vite:{resume:result}}
  writeFileSync(evidence,JSON.stringify(input))
  assert.throws(()=>auditSDKCandidateEvidence(root,evidence,root),/browser mismatch/)
})

test('validates a shared workflow report against every claimed workflow',()=>{
  const root=fixture(),manifestSHA256=createHash('sha256').update(readFileSync(join(root,'manifest.json'))).digest('hex')
  const reportName='site-start-counter-diagnostics.json',evidence=join(root,'evidence.json')
  writeFileSync(join(root,reportName),JSON.stringify({failure:'',resumeWorkspace:true,offlineRequests:[],cleanup:{acknowledged:true},state:{restored:'fingerprint'},savedWorkspace:{fingerprint:'fingerprint'},stageEvents:[{stage:'saved Start app resumed offline, interacted and live-edited in a fresh kernel',status:'completed'}]}))
  const result={status:'passed',evidence:[reportName]}
  writeFileSync(evidence,JSON.stringify({format:1,manifestSHA256,buildProfile:'sync-o2',results:{chromium:{start:{cold:result,resume:result},vite:{resume:result}}}}))
  assert.throws(()=>auditSDKCandidateEvidence(root,evidence,root),/Start evidence used for vite/)
})

function strictConsumerEvidence(workflow){
  const root=fixture(),manifestSHA256=createHash('sha256').update(readFileSync(join(root,'manifest.json'))).digest('hex')
  const reportPath=join(root,workflow==='vite'?'sdk-vite7-resume.json':'sdk-start-diagnostics.json'),evidence=join(root,'evidence.json')
  const resources=()=>({processes:{active:0,retained:0},network:{handles:0,listeners:0,details:[]},fileSessions:0,executing:false,installing:false,nativeParser:{enabled:true,state:'idle',shutdownPending:false}})
  const rounds=[false,true].map(resume=>workflow==='vite'
    ?{resume,deadline:false,shutdown:{closed:true},resources:resources(),tests:[{status:1},{status:0,stdout:'MESSAGE_TEST_PASSED'}],install:resume?{skipped:true}:{installed:1},...(resume?{byteExactRestore:true}:{})}
    :{resume,roundDeadline:false,shutdown:{acknowledged:true},resources:resources(),paths:['/project/src/routes/about.tsx'],...(resume?{byteExactRestore:true}:{})})
  const report=workflow==='vite'?{nativeCompiler:true,resumeExternalRequests:[],errors:[],rounds}:{
    saveResume:true,resume:true,diagnostics:[],resumeExternalRequests:[],nativeCompiler:true,
    engine:{profile:'sync-o2',options:{experimentalFibers:true,experimentalRolldownParser:{}},requiresIsolation:true},
    serverCompilerWorkers:['cold','resume'],rounds,cleanup:{acknowledged:true},
    state:{install:{skipped:true,reason:'offline snapshot restore'},ssr:{status:200}},
    stages:Array.from({length:2},()=>['hydration effect committed','client counter updated','POST server function completed','navigation and document-preserving route HMR completed']).flat(),
  }
  const result={status:'passed',evidence:[reportPath.split('/').at(-1)]}
  writeFileSync(evidence,JSON.stringify({format:1,manifestSHA256,buildProfile:'sync-o2',results:{chromium:{[workflow]:{cold:result,resume:result}}}}))
  return {root,evidence,reportPath,report,audit(value=report){writeFileSync(reportPath,JSON.stringify(value));return auditSDKCandidateEvidence(root,evidence,root)}}
}

test('split strict workflow evidence binds both packages and deployment without weakening resume assertions',()=>{
  const {root,evidence,reportPath,report}=strictConsumerEvidence('vite')
  writeFileSync(join(root,'package-assets.json'),JSON.stringify({format:1,files:[]}))
  writeFileSync(join(root,'runtime-profile.json'),JSON.stringify({buildProfile:'sync-o2'}))
  const digest=createHash('sha256').update(readFileSync(join(root,'package-assets.json'))).digest('hex')
  const binding={packaging:'split',manifestSHA256:digest,runtimeManifestSHA256:digest,tarballSHA256:'a'.repeat(64),runtimeTarballSHA256:'b'.repeat(64),deploymentManifestSHA256:'c'.repeat(64)}
  const input={...JSON.parse(readFileSync(evidence,'utf8')),...binding}
  writeFileSync(evidence,JSON.stringify(input))
  const run=value=>{writeFileSync(reportPath,JSON.stringify(value));return auditSDKCandidateEvidence(root,evidence,root,{runtimeDirectory:root})}
  const good={...report,...binding}
  assert.equal(run(good).passed,true)
  for(const key of Object.keys(binding))assert.throws(()=>run({...good,[key]:'wrong'}),/split .* mismatch/)
  const changed=structuredClone(good);changed.rounds[1].byteExactRestore=false
  assert.throws(()=>run(changed),/restore was not byte exact/)
  changed.rounds[1].byteExactRestore=true;changed.rounds[0].shutdown={closed:false}
  assert.throws(()=>run(changed),/shutdown acknowledgement missing/)
})

for(const workflow of ['vite','start'])test(workflow+' consumer requires observed shutdown in both rounds and byte-exact resume',()=>{
  const {report,audit}=strictConsumerEvidence(workflow)
  assert.equal(audit().passed,true)
  const field=workflow==='vite'?'closed':'acknowledged'
  for(const index of [0,1])for(const value of [undefined,{}, {[field]:false}]){
    const changed=structuredClone(report);changed.rounds[index].shutdown=value
    assert.throws(()=>audit(changed),/shutdown acknowledgement missing/)
  }
  for(const value of [undefined,false,'true']){
    const changed=structuredClone(report);changed.rounds[1].byteExactRestore=value
    assert.throws(()=>audit(changed),/restore was not byte exact/)
  }
  if(workflow==='start')for(const value of [undefined,{}, {acknowledged:false}]){
    const changed=structuredClone(report);changed.cleanup=value
    assert.throws(()=>audit(changed),/final shutdown acknowledgement missing/)
  }
})

test('Start consumer never infers missing native parser cleanup details',()=>{
  const {report,audit}=strictConsumerEvidence('start')
  for(const index of [0,1]){
    const absent=structuredClone(report);delete absent.rounds[index].resources.nativeParser
    assert.throws(()=>audit(absent),/native parser/)
    for(const [field,invalid] of [['enabled',false],['state','closing'],['shutdownPending',true]]){
      for(const value of [undefined,invalid]){
        const changed=structuredClone(report);changed.rounds[index].resources.nativeParser[field]=value
        assert.throws(()=>audit(changed),/native parser/)
      }
    }
  }
})
