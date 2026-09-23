import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {relative,resolve,sep} from 'node:path'
import {pathToFileURL} from 'node:url'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const readJSON=path=>{const bytes=readFileSync(path);return {bytes,value:JSON.parse(bytes)}}
const cleanReference=path=>typeof path==='string'&&path.length>0&&!path.includes('\\')&&!path.split('/').some(part=>!part||part==='.'||part==='..')

export function auditSDKCandidateEvidence(candidateDirectory,evidenceInput,repositoryRoot=process.cwd(),{runtimeDirectory}={}){
  const candidate=resolve(candidateDirectory),root=resolve(repositoryRoot)
  const manifestRecord=readJSON(resolve(candidate,runtimeDirectory?'package-assets.json':'manifest.json'))
  const runtime=runtimeDirectory&&resolve(runtimeDirectory)
  const manifest=runtime?readJSON(resolve(runtime,'runtime-profile.json')).value:manifestRecord.value,manifestSHA256=hash(manifestRecord.bytes)
  const input=readJSON(resolve(evidenceInput)).value
  assert.equal(input.format,1,'Unsupported evidence format')
  assert.equal(input.manifestSHA256,manifestSHA256,'Evidence manifest mismatch')
  assert.equal(input.buildProfile,manifest.buildProfile,'Evidence build profile mismatch')
  let splitBinding
  if(runtime){
    assert.equal(input.packaging,'split','Split evidence must identify its packaging')
    splitBinding={packaging:'split',manifestSHA256,runtimeManifestSHA256:hash(readFileSync(resolve(runtime,'package-assets.json')))}
    for(const key of ['tarballSHA256','runtimeTarballSHA256','deploymentManifestSHA256']){
      assert.match(input[key]??'',/^[a-f0-9]{64}$/,'Missing split evidence identity: '+key)
      splitBinding[key]=input[key]
    }
    assert.equal(input.runtimeManifestSHA256,splitBinding.runtimeManifestSHA256,'Evidence runtime manifest mismatch')
  }
  for(const [workflow,minimum] of Object.entries(input.minimumCycles??{})){
    assert.ok(['vite','start'].includes(workflow),`Unknown minimum-cycle workflow: ${workflow}`)
    assert.ok(Number.isSafeInteger(minimum)&&minimum>0,`Invalid minimum-cycle count for ${workflow}`)
  }
  const references=new Map()
  if(input.integration?.status==='passed'){
    assert.equal(input.integration.browser,'chromium','TanStack.com integration must identify its tested browser')
    assert.ok(cleanReference(input.integration.evidence),`Invalid integration evidence reference: ${input.integration.evidence}`)
    assert.match(input.integration.tarballSHA256,/^[0-9a-f]{64}$/,'Invalid integration tarball SHA256')
    const path=resolve(root,input.integration.evidence),inside=relative(root,path)
    assert.ok(inside&&!inside.startsWith('..'+sep)&&!inside.startsWith('../')&&!inside.includes(sep+'..'+sep),`Integration evidence outside repository: ${input.integration.evidence}`)
    references.set(input.integration.evidence,{path,contexts:[{browser:input.integration.browser,workflow:'tanstack-site'}]})
  }
  for(const [browser,workflows] of Object.entries(input.results??{}))for(const [workflow,phases] of Object.entries(workflows))for(const [phase,result] of Object.entries(phases)){
    if(result.status!=='passed')continue
    assert.ok(Array.isArray(result.evidence)&&result.evidence.length,`Missing evidence for ${browser}/${workflow}/${phase}`)
    const minimum=input.minimumCycles?.[workflow]
    if(minimum&&browser==='safari'){
      assert.ok(result.evidence.some(reference=>/^safari-framework-acceptance(?:-[A-Za-z0-9_-]+)?\.json$/.test(reference.split('/').at(-1))),`Missing actual Safari acceptance evidence for safari/${workflow}/${phase}`)
    }else if(minimum){
      const diagnosticNames=workflow==='start'?new Set(['sdk-start-diagnostics.json','site-start-counter-diagnostics.json']):new Set(['sdk-vite7-resume.json'])
      const diagnosticCycles=new Set(result.evidence.filter(reference=>diagnosticNames.has(reference.split('/').at(-1))).map(reference=>reference.slice(0,reference.lastIndexOf('/'))))
      const engineCycles=new Set(result.evidence.filter(reference=>reference.split('/').at(-1)==='sdk-engine-evidence.json').map(reference=>reference.slice(0,reference.lastIndexOf('/'))))
      assert.ok(diagnosticCycles.size>=minimum,`Need ${minimum} independent evidence cycles for ${browser}/${workflow}/${phase}; found ${diagnosticCycles.size}`)
      for(const cycle of diagnosticCycles)assert.ok(engineCycles.has(cycle),`Missing engine evidence for cycle: ${cycle}`)
    }
    for(const reference of result.evidence){
      assert.ok(cleanReference(reference),`Invalid evidence reference: ${reference}`)
      const path=resolve(root,reference),inside=relative(root,path)
      assert.ok(inside&&!inside.startsWith('..'+sep)&&!inside.startsWith('../')&&!inside.includes(sep+'..'+sep),`Evidence outside repository: ${reference}`)
      if(!references.has(reference))references.set(reference,{path,contexts:[]})
      references.get(reference).contexts.push({browser,workflow,phase})
    }
  }
  const files=[]
  for(const [reference,{path,contexts}] of references){
    const {bytes,value}=readJSON(path),name=reference.split('/').at(-1)
    // Read and hash each artifact once, but validate every claimed use of it.
    for(const {browser,workflow} of contexts){
    if(splitBinding)for(const[key,expected]of Object.entries(splitBinding))assert.equal(value[key],expected,`${reference}: split ${key} mismatch`)
    if(name==='sdk-engine-evidence.json'){
      assert.equal(value.manifestSHA256,manifestSHA256,`${reference}: manifest mismatch`)
      assert.equal(value.buildProfile,manifest.buildProfile,`${reference}: build profile mismatch`)
      assert.deepEqual(value.errors,[],`${reference}: engine verification errors`)
      assert.ok(Array.isArray(value.loads)&&value.loads.length>0,`${reference}: no verified engine loads`)
      assert.equal(value.environment?.project,browser==='playwright-webkit'?'webkit':browser,`${reference}: browser mismatch`)
      assert.equal(value.environment?.actualSafari,false,`${reference}: Playwright evidence mislabeled as Safari`)
    }else if(name==='sdk-vite7-resume.json'){
      assert.equal(workflow,'vite',`${reference}: Vite evidence used for ${workflow}`)
      assert.ok(!value.failure,`${reference}: workflow failure`)
      assert.equal(value.nativeCompiler,true,`${reference}: packaged Vite compiler was not enabled`)
      assert.deepEqual(value.resumeExternalRequests,[],`${reference}: external resume requests`)
      assert.deepEqual(value.errors,[],`${reference}: owner page errors`)
      assert.equal(value.rounds?.length,2,`${reference}: cold and resume rounds required`)
      assert.deepEqual(value.rounds.map(round=>round.resume),[false,true],`${reference}: wrong round order`)
      for(const round of value.rounds){
        assert.equal(round.deadline,false,`${reference}: workflow deadline`)
        assert.deepEqual(round.shutdown,{closed:true},`${reference}: session shutdown acknowledgement missing`)
        assert.deepEqual(round.resources?.processes,{active:0,retained:0},`${reference}: process leak`)
        assert.equal(round.resources?.network?.handles,0,`${reference}: network handle leak`)
        assert.equal(round.resources?.network?.listeners,0,`${reference}: network listener leak`)
        assert.deepEqual(round.resources?.network?.details??[],[],`${reference}: network resource detail leak`)
        assert.ok(round.tests?.some(test=>test.status!==0),`${reference}: missing negative test`)
        assert.ok(round.tests?.some(test=>test.status===0&&test.stdout?.includes('MESSAGE_TEST_PASSED')),`${reference}: missing passing test`)
      }
      assert.equal(value.rounds[0].install?.installed>0,true,`${reference}: cold install missing`)
      assert.equal(value.rounds[1].install?.skipped,true,`${reference}: resume reinstalled dependencies`)
      assert.equal(value.rounds[1].byteExactRestore,true,`${reference}: restore was not byte exact`)
    }else if(name==='site-start-counter-diagnostics.json'){
      assert.equal(workflow,'start',`${reference}: Start evidence used for ${workflow}`)
      assert.equal(value.failure,'',`${reference}: workflow failure`)
      assert.equal(value.resumeWorkspace,true,`${reference}: resume missing`)
      assert.deepEqual(value.offlineRequests,[],`${reference}: external resume requests`)
      assert.equal(value.cleanup?.acknowledged,true,`${reference}: shutdown acknowledgement missing`)
      assert.deepEqual(value.state?.restored,value.savedWorkspace?.fingerprint,`${reference}: restored workspace fingerprint mismatch`)
      assert.ok(value.stageEvents?.some(event=>event.stage==='saved Start app resumed offline, interacted and live-edited in a fresh kernel'&&event.status==='completed'),`${reference}: resumed interaction stage missing`)
    }else if(name==='sdk-start-diagnostics.json'){
      assert.equal(workflow,'start',`${reference}: Start evidence used for ${workflow}`)
      assert.equal(value.failure,undefined,`${reference}: workflow failure`)
      assert.equal(value.saveResume,true,`${reference}: save/resume workflow missing`)
      assert.equal(value.resume,true,`${reference}: resume round missing`)
      assert.deepEqual(value.diagnostics,[],`${reference}: owner or preview errors`)
      assert.deepEqual(value.resumeExternalRequests,[],`${reference}: external resume requests`)
      assert.equal(value.nativeCompiler,true,`${reference}: browser compiler was not enabled`)
      assert.equal(value.engine?.profile,manifest.buildProfile,`${reference}: selected engine profile mismatch`)
      assert.equal(value.engine?.options?.experimentalFibers,true,`${reference}: fiber engine was not selected`)
      assert.equal(typeof value.engine?.options?.experimentalRolldownParser,'object',`${reference}: native Rolldown parser was not selected`)
      assert.equal(value.engine?.requiresIsolation,true,`${reference}: isolated hosting requirement missing`)
      assert.ok(Array.isArray(value.serverCompilerWorkers)&&value.serverCompilerWorkers.length>=2,`${reference}: cold and resume compiler workers missing`)
      assert.equal(value.rounds?.length,2,`${reference}: cold and resume rounds required`)
      assert.deepEqual(value.rounds.map(round=>round.resume),[false,true],`${reference}: wrong round order`)
      assert.equal(value.cleanup?.acknowledged,true,`${reference}: final shutdown acknowledgement missing`)
      for(const round of value.rounds){
        assert.equal(round.roundDeadline,false,`${reference}: workflow deadline`)
        assert.deepEqual(round.shutdown,{acknowledged:true},`${reference}: kernel shutdown acknowledgement missing`)
        assert.deepEqual(round.resources?.processes,{active:0,retained:0},`${reference}: process leak`)
        assert.equal(round.resources?.network?.handles,0,`${reference}: network handle leak`)
        assert.equal(round.resources?.network?.listeners,0,`${reference}: network listener leak`)
        assert.deepEqual(round.resources?.network?.details??[],[],`${reference}: network resource detail leak`)
        assert.equal(round.resources?.fileSessions,0,`${reference}: file session leak`)
        assert.equal(round.resources?.executing,false,`${reference}: execution remained active`)
        assert.equal(round.resources?.installing,false,`${reference}: installation remained active`)
        assert.equal(round.resources?.nativeParser?.enabled,true,`${reference}: native parser was not enabled`)
        assert.equal(round.resources?.nativeParser?.state,'idle',`${reference}: native parser was not idle`)
        assert.equal(round.resources?.nativeParser?.shutdownPending,false,`${reference}: native parser shutdown remained pending`)
      }
      assert.deepEqual(value.rounds[0].paths,value.rounds[1].paths,`${reference}: restored workspace paths differ`)
      assert.equal(value.rounds[1].byteExactRestore,true,`${reference}: restore was not byte exact`)
      assert.ok(value.rounds[0].paths?.includes('/project/src/routes/about.tsx'),`${reference}: edited route missing from snapshot`)
      assert.deepEqual(value.state?.install,{skipped:true,reason:'offline snapshot restore'},`${reference}: resume reinstalled dependencies`)
      assert.equal(value.state?.ssr?.status,200,`${reference}: resumed SSR did not return 200`)
      for(const stage of ['hydration effect committed','client counter updated','POST server function completed','navigation and document-preserving route HMR completed']){
        assert.equal(value.stages?.filter(candidate=>candidate===stage).length,2,`${reference}: ${stage} did not complete in cold and resume rounds`)
      }
    }else if(/^safari-framework-acceptance(?:-[A-Za-z0-9_-]+)?\.json$/.test(name)){
      assert.equal(browser,'safari',`${reference}: actual Safari evidence used for ${browser}`)
      assert.equal(value.passed,true,`${reference}: Safari acceptance failed`)
      assert.equal(value.actualSafari,true,`${reference}: evidence is not actual Safari`)
      assert.equal(value.browser?.name,'Safari',`${reference}: browser mismatch`)
      assert.ok(typeof value.browser?.version==='string'&&value.browser.version.length>0,`${reference}: Safari version missing`)
      assert.match(value.method??'',/safaridriver/,`${reference}: Safari WebDriver method missing`)
      assert.equal(value.artifact?.manifestSHA256,manifestSHA256,`${reference}: manifest mismatch`)
      assert.equal(value.artifact?.buildProfile,manifest.buildProfile,`${reference}: build profile mismatch`)
      assert.match(value.artifact?.tarballSHA256??'',/^[0-9a-f]{64}$/,`${reference}: tarball hash missing`)
      assert.ok(Number.isSafeInteger(value.requiredRepetitions)&&value.requiredRepetitions>=3,`${reference}: insufficient required repetitions`)
      assert.ok(Array.isArray(value.rounds)&&value.rounds.length>=value.requiredRepetitions,`${reference}: insufficient completed Safari rounds`)
      for(const round of value.rounds)for(const candidateWorkflow of ['vite','start'])for(const candidatePhase of ['cold','resume'])assert.equal(round.results?.[candidateWorkflow]?.[candidatePhase]?.status,'passed',`${reference}: Safari ${candidateWorkflow}/${candidatePhase} failed in round ${round.index}`)
      for(const candidateWorkflow of ['vite','start'])for(const candidatePhase of ['cold','resume'])assert.equal(value.results?.[candidateWorkflow]?.[candidatePhase]?.status,'passed',`${reference}: Safari ${candidateWorkflow}/${candidatePhase} aggregate failed`)
    }else if(/^tanstack-site-[A-Za-z0-9_-]+-acceptance\.json$/.test(name)){
      assert.equal(workflow,'tanstack-site',`${reference}: integration evidence used for ${workflow}`)
      assert.equal(value.result,'passed',`${reference}: integration failed`)
      assert.equal(value.browser?.name,'Chromium',`${reference}: browser mismatch`)
      assert.equal(value.sdk?.artifactBound,true,`${reference}: artifact binding missing`)
      assert.equal(value.sdk?.manifest?.sha256,manifestSHA256,`${reference}: manifest mismatch`)
      assert.equal(value.sdk?.buildProfile,manifest.buildProfile,`${reference}: build profile mismatch`)
      assert.equal(value.sdk?.tarball?.sha256,input.integration.tarballSHA256,`${reference}: tarball mismatch`)
      assert.equal(value.projectIdentity?.sdkManifestSHA256,manifestSHA256,`${reference}: TanStack.com selected a different SDK`)
      assert.ok(value.workspace?.files>0&&value.workspace?.packageFiles>0,`${reference}: saved workspace evidence missing`)
      assert.deepEqual(value.offlineResume?.dependencyRequests,[],`${reference}: resume requested dependencies`)
      assert.deepEqual(value.diagnostics?.pageErrors,[],`${reference}: page errors`)
      assert.deepEqual(value.diagnostics?.consoleErrors,[],`${reference}: console errors`)
      assert.deepEqual(value.diagnostics?.httpErrors,[],`${reference}: HTTP errors`)
      assert.ok(value.diagnostics?.blockedExternalRequests?.every(request=>new URL(request.url).hostname.endsWith('.ingest.us.sentry.io')),`${reference}: unexpected blocked request`)
      assert.ok(value.diagnostics?.blockedTelemetryErrors?.every(error=>error.includes('ERR_BLOCKED_BY_CLIENT')),`${reference}: unexpected blocked telemetry diagnostic`)
      const ordered=['runClickedMs','ssrVisibleMs','hydratedMs','savedMs','resumeStartedMs','resumedMs','resumedInteractionMs','stoppedMs'].map(name=>value.timings?.[name])
      assert.ok(ordered.every(Number.isFinite),`${reference}: integration timings missing`)
      assert.deepEqual([...ordered].sort((a,b)=>a-b),ordered,`${reference}: integration phases out of order`)
    }else throw Error(`Unsupported evidence file: ${reference}`)
    }
    files.push({path:reference,bytes:bytes.length,sha256:hash(bytes)})
  }
  return {format:1,...splitBinding,manifestSHA256,buildProfile:manifest.buildProfile,passed:true,files:files.sort((a,b)=>a.path.localeCompare(b.path))}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  assert.equal(process.argv.length,4,'Usage: node scripts/audit-sdk-candidate-evidence.mjs CANDIDATE_SDK EVIDENCE_JSON')
  console.log(JSON.stringify(auditSDKCandidateEvidence(process.argv[2],process.argv[3],process.cwd(),{runtimeDirectory:process.env.SDK_RUNTIME_OUTPUT}),null,2))
}
