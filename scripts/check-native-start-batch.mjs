import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {resolve,join,isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
import {isDeepStrictEqual} from 'node:util'
import {classifyNavigationCancellations} from './native-firefox-start-client.mjs'

const stages=['SSR','hydrated','HMR without owner reload','server functions and filesystem verified']
const positive=value=>Number.isSafeInteger(value)&&value>0
const absentErrors=(value,label)=>{
  for(const field of ['failure','failureName','failureMessage','drainError','cleanupError','error'])assert.ok(!value[field],`${label}: ${field}`)
}

export function checkNativeStartBatch(manifestBytes,entries){
  const manifest=JSON.parse(manifestBytes.toString()),manifestSHA256=createHash('sha256').update(manifestBytes).digest('hex')
  assert.ok(entries.length>=3,'At least three native Start reports are required')
  assert.ok(typeof manifest.buildProfile==='string'&&manifest.buildProfile,'Missing SDK build profile')
  const profiles=new Set(),paths=new Set(),runs=[]
  let browser,project
  for(const {path,report} of entries){
    const label=path??`report ${runs.length+1}`
    assert.ok(!paths.has(resolve(label)),`${label}: duplicate report path`);paths.add(resolve(label))
    assert.equal(report.passed,true,`${label}: report did not pass`);absentErrors(report,label)
    assert.equal(report.manifestSHA256,manifestSHA256,`${label}: SDK manifest mismatch`)
    assert.equal(report.buildProfile,manifest.buildProfile,`${label}: build profile mismatch`)
    const sourceHashes=report.sourceHashes
    assert.ok(sourceHashes&&typeof sourceHashes==='object'&&!Array.isArray(sourceHashes)&&Object.keys(sourceHashes).length>0&&Object.entries(sourceHashes).every(([name,hash])=>name&&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)),`${label}: missing or invalid source hashes`)
    assert.ok(typeof report.lockfileSHA256==='string'&&/^[a-f0-9]{64}$/.test(report.lockfileSHA256),`${label}: missing or invalid lockfile hash`)
    assert.ok(report.provenance&&typeof report.provenance==='object'&&!Array.isArray(report.provenance)&&Object.keys(report.provenance).length>0,`${label}: missing project provenance`)
    const projectIdentity={sourceHashes,lockfileSHA256:report.lockfileSHA256,provenance:report.provenance}
    if(project)assert.deepEqual(projectIdentity,project,`${label}: project source or dependency graph mismatch`);else project=projectIdentity
    const identity={binary:report.browser?.binary,version:report.browser?.version}
    assert.ok(Object.values(identity).every(value=>typeof value==='string'&&value),`${label}: missing browser identity`)
    if(browser)assert.deepEqual(identity,browser,`${label}: browser binary/version mismatch`);else browser=identity
    const profile=report.browser?.profile,args=report.browser?.args
    assert.ok(typeof profile==='string'&&isAbsolute(profile),`${label}: missing fresh profile`)
    assert.ok(!profiles.has(resolve(profile)),`${label}: browser profile reused`);profiles.add(resolve(profile))
    assert.ok(Array.isArray(args)&&args.includes('-no-remote')&&args.includes('-headless')&&args.filter(arg=>arg==='-profile').length===1&&args[args.indexOf('-profile')+1]===profile,`${label}: fresh-profile launch arguments missing`)
    assert.ok(!args.some(arg=>/juggler|remote-debugging|marionette/i.test(arg)),`${label}: automation debugger flag`)
    assert.equal(report.offline,true,`${label}: offline resume not enabled`)
    assert.deepEqual(report.violations,[],`${label}: offline policy violations`)
    const counts={}
    for(const [name,resumed] of [['cold',false],['result',true]]){
      const phase=report[name],where=`${label} ${name}`
      assert.ok(phase&&typeof phase==='object',`${where}: missing phase`)
      absentErrors(phase,where)
      assert.equal(phase.resumed,resumed,`${where}: wrong phase`)
      assert.equal(phase.crossOriginIsolated,true,`${where}: not isolated`)
      assert.deepEqual(phase.errors,[],`${where}: owner errors`)
      const expected=[resumed?'restored files, dependencies and optimizer cache without install':'installed portable graph',...stages]
      assert.deepEqual(phase.stages,expected,`${where}: incomplete acceptance stages`)
      assert.deepEqual(report.stages?.filter(row=>row.resumed===resumed).map(row=>row.name),expected,`${where}: receiver stages differ`)
      assert.equal(phase.ssr?.status,200,`${where}: SSR status`)
      assert.equal(phase.ssr?.expected,resumed?'Increment 2?':'Add 1 to 0?',`${where}: SSR counter`)
      for(const field of ['seenBootstrap','hydrated','streamEnded'])assert.equal(phase.readiness?.[field],true,`${where}: ${field}`)
      assert.ok(positive(phase.parserAfterSSR?.completedCalls)&&positive(phase.parserAfterSSR?.callable?.completed),`${where}: missing parser/compiler execution`)
      for(const state of [phase.parserAfterSSR,phase.resources?.nativeParser]){
        assert.equal(state?.failedCalls,0,`${where}: native parser failures`)
        assert.equal(state?.callable?.failed,0,`${where}: callable failures`)
      }
      assert.equal(phase.resources?.processes?.active,0,`${where}: active processes`)
      assert.equal(phase.shutdownAcknowledged,true,`${where}: missing shutdown acknowledgement`)
      for(const field of ['previewDiagnostics','documentEvents','http','reloads','completedPreviewRequests'])assert.ok(Array.isArray(phase[field]),`${where}: missing ${field}`)
      const classification=classifyNavigationCancellations(phase)
      assert.deepEqual(classification.fatal,[],`${where}: unclassified preview errors`)
      assert.deepEqual(phase.previewClassification,classification,`${where}: stored navigation classification differs`)
      for(const event of phase.documentEvents.filter(event=>['error','unhandledrejection'].includes(event.kind)))assert.ok(classification.cancellations.some(row=>isDeepStrictEqual(row.error,event)),`${where}: unclassified document error`)
      assert.ok(phase.http.every(row=>!row.bodyError),`${where}: HTTP body errors`)
      counts[name]=classification.cancellations.length
    }
    assert.equal(report.result.passed,true,`${label}: resumed result did not pass`)
    assert.ok(positive(report.cold.install?.installed),`${label}: cold install missing`)
    assert.ok(!report.result.install,`${label}: resume installed dependencies`)
    const saved=report.cold.saved
    assert.ok(saved&&/^[a-f0-9]{64}$/.test(saved.sha256)&&['files','bytes','packageFiles','cacheFiles'].every(key=>positive(saved[key])),`${label}: invalid saved workspace fingerprint`)
    assert.ok(saved.cacheFiles<=saved.packageFiles&&saved.packageFiles<=saved.files,`${label}: invalid fingerprint file counts`)
    assert.deepEqual(saved,report.result.restored,`${label}: restored workspace fingerprint mismatch`)
    runs.push({path:label,profile,expectedNavigationCancellations:{cold:counts.cold,resume:counts.result}})
  }
  return {scope:'Native Start cold and offline-resume batch only, not Safari or a general release gate',passed:true,manifestSHA256,buildProfile:manifest.buildProfile,browser,project,runs}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [sdk,...reports]=process.argv.slice(2)
  if(!sdk||reports.length<3)throw Error('Usage: node check-native-start-batch.mjs SDK_DIRECTORY REPORT1 REPORT2 REPORT3 [REPORT...]')
  const result=checkNativeStartBatch(readFileSync(join(resolve(sdk),'manifest.json')),reports.map(path=>({path:resolve(path),report:JSON.parse(readFileSync(path,'utf8'))})))
  console.log(JSON.stringify(result,null,2))
}
