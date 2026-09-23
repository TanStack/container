import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {startSafariFrameworkProxy} from './safari-framework-proxy.mjs'
import {safariInstallStageTraceSource} from './safari-install-stage-trace.mjs'
import {installSafariPreviewLiveness,installSafariPreviewCollector} from './safari-preview-liveness.mjs'
import {extractFreshFrameworkScriptResult,parseFrameworkScriptResults} from '../tests/sdk/helpers/framework-script-result.mjs'
import {activateSafariAutomation,assertSafariAutomationAvailable,createSafariEvidence,startSafariDriver,stopSafariAutomationProcess,stopSafariDriver} from './safari-webdriver.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
export function parseSafariWebContentProcesses(value){
  return String(value).split('\n').map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/)).filter(Boolean).map(match=>({pid:Number(match[1]),residentKiB:Number(match[2]),cpuPercent:Number(match[3]),elapsed:match[4],command:match[5]})).filter(process=>process.command.includes('com.apple.WebKit.WebContent'))
}
function sampleSafariWebContentProcesses(){
  const result=spawnSync('ps',['ax','-o','pid=,rss=,%cpu=,etime=,comm='],{encoding:'utf8'})
  if(result.status!==0)throw Error(`Could not sample Safari WebContent memory: ${result.stderr||`ps exited ${result.status}`}`)
  return parseSafariWebContentProcesses(result.stdout)
}
async function sampleSafariPostWorkflowIdle(durationMs){
  if(!Number.isInteger(durationMs)||durationMs<0||durationMs>60_000)throw Error('Safari post-workflow idle sampling must be between 0 and 60000ms')
  const started=Date.now(),samples=[]
  for(;;){
    samples.push({at:new Date().toISOString(),elapsedMs:Date.now()-started,processes:sampleSafariWebContentProcesses()})
    const remaining=durationMs-(Date.now()-started)
    if(remaining<=0)break
    await delay(Math.min(5_000,remaining))
  }
  return {durationMs,samples}
}
const emptyResults=()=>({vite:{cold:{status:'unverified'},resume:{status:'unverified'}},start:{cold:{status:'unverified'},resume:{status:'unverified'}}})
const aggregateResults=(rounds,requiredRepetitions)=>Object.fromEntries(['vite','start'].map(kind=>[kind,Object.fromEntries(['cold','resume'].map(phase=>{
  const outcomes=rounds.map(round=>round.results[kind][phase])
  if(rounds.length>=requiredRepetitions&&outcomes.every(outcome=>outcome.status==='passed'))return [phase,{status:'passed',evidence:[`${rounds.length} independent Safari rounds`]}]
  const failed=outcomes.find(outcome=>outcome.status==='failed')
  return [phase,failed??{status:'unverified'}]
}))]))

export function readSafariArtifactIdentity({sdkRoot,tarball,expected={}}){
  const root=realpathSync(sdkRoot),archive=realpathSync(tarball)
  for(const path of ['manifest.json','examples/frameworks/server.mjs'])if(!existsSync(join(root,path)))throw Error(`SDK artifact is missing ${path}`)
  const manifestBytes=readFileSync(join(root,'manifest.json')),manifest=JSON.parse(manifestBytes)
  const identity={sdkRoot:root,manifestSHA256:hash(manifestBytes),buildProfile:manifest.buildProfile??'default',tarball:archive,tarballSHA256:hash(readFileSync(archive))}
  for(const [name,value] of Object.entries(expected))if(value!==undefined&&identity[name]!==value)throw Error(`SDK ${name} mismatch: expected ${value}, received ${identity[name]}`)
  return identity
}

export function installSafariAcceptanceConsumer(identity){
  const workspace=realpathSync(mkdtempSync(join(tmpdir(),'browser-sandbox-safari-consumer-')))
  const consumer=join(workspace,'consumer')
  mkdirSync(consumer)
  writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'safari-sdk-acceptance',private:true,type:'module'},null,2)+'\n')
  const result=spawnSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--no-package-lock',identity.tarball],{
    cwd:consumer,
    encoding:'utf8',
    env:{...process.env,npm_config_cache:join(workspace,'npm-cache'),npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'},
  })
  if(result.status!==0)throw Error(`Could not install the Safari acceptance package\n${result.stdout}${result.stderr}`)
  const sdkRoot=realpathSync(join(consumer,'node_modules/@tanstack/browser-sandbox-experimental'))
  const manifestSHA256=hash(readFileSync(join(sdkRoot,'manifest.json')))
  if(manifestSHA256!==identity.manifestSHA256)throw Error(`Installed Safari acceptance manifest mismatch: expected ${identity.manifestSHA256}, received ${manifestSHA256}`)
  if(!existsSync(join(sdkRoot,'examples/frameworks/server.mjs')))throw Error('Installed Safari acceptance package is missing examples/frameworks/server.mjs')
  return {...identity,consumer,sdkRoot}
}

export function classifySafariCapacityFailure(code,recovery){
  if(code==='ERR_SAFARI_NOT_VISIBLE')return 'safari-not-visible'
  if(code!=='invalid session id')return 'workflow-failure'
  return recovery?.status==='passed'?'webdriver-session-lost':'safari-process-or-automation-unavailable'
}

async function waitFor(driver,probe,{timeoutMs=60_000,description='condition'}={}){
  const deadline=Date.now()+timeoutMs;let last
  while(Date.now()<deadline){try{const value=await probe();if(value)return value}catch(error){last=error}await delay(200)}
  throw Object.assign(Error(`Timed out waiting for ${description}${last?`: ${last.message}`:''}`),{code:'ERR_SAFARI_ACCEPTANCE_TIMEOUT'})
}
const find=(driver,selector,timeoutMs=60_000)=>waitFor(driver,()=>driver.find(selector),{timeoutMs,description:selector})
async function textIs(driver,selector,expected,timeoutMs=60_000){return waitFor(driver,async()=>await driver.text(await driver.find(selector))===expected,{timeoutMs,description:`${selector} text ${JSON.stringify(expected)}`})}
async function textIncludes(driver,selector,expected,timeoutMs=60_000){return waitFor(driver,async()=>String(await driver.text(await driver.find(selector))).includes(expected),{timeoutMs,description:`${selector} containing ${JSON.stringify(expected)}`})}
async function chooseProject(driver,kind){
  const select=await find(driver,'#project',15_000)
  const selected=await driver.execute(`
    const select=arguments[0],value=arguments[1]
    select.value=value
    select.dispatchEvent(new Event('change',{bubbles:true}))
    return select.value
  `,[select,kind])
  if(selected!==kind)throw Error(`Safari WebDriver did not select project ${kind}`)
}
async function clickControl(driver,selector,timeoutMs=60_000){
  const control=await find(driver,selector,timeoutMs)
  const clicked=await driver.execute('if(arguments[0].disabled)return false;arguments[0].click();return true',[control])
  if(!clicked)throw Error(`Safari owner control ${selector} is disabled`)
}
async function enterPreview(driver){const frame=await find(driver,'#preview iframe',180_000);await driver.execute('arguments[0].scrollIntoView({block:"center",inline:"center"})',[frame]);await driver.frame(frame)}
async function leavePreview(driver){await driver.parentFrame()}
export async function safariPreviewIsAbsent(driver){
  try{await driver.find('#preview iframe');return false}
  catch(error){if(error?.code==='no such element')return true;throw error}
}
export async function withSafariCleanup(body,cleanup){
  let failed=false,primaryError
  try{return await body()}
  catch(error){failed=true;primaryError=error;throw error}
  finally{
    try{await cleanup()}
    catch(cleanupError){
      if(!failed)throw cleanupError
      if(primaryError instanceof Error){
        primaryError.cleanupErrors=[...(primaryError.cleanupErrors??[]),cleanupError]
        primaryError.message+='\nSafari cleanup failed: '+String(cleanupError)
      }
    }
  }
}
async function setSource(driver,transform){const source=await find(driver,'#source'),before=String(await driver.property(source,'value')),after=transform(before);if(after===before)throw Error('Source edit did not match the expected fixture text');await driver.clear(source);await driver.value(source,after);if(await driver.property(source,'value')!==after)throw Error('Safari WebDriver did not apply the complete source edit');return after}
export async function runSafariFrameworkScript(driver,expected,records,name){
  const selectedScript=await driver.property(await find(driver,'#script'),'value')
  if(selectedScript!=='test')throw Error(`Expected selected script test, received ${JSON.stringify(selectedScript)}`)
  const beforeCount=parseFrameworkScriptResults(await driver.text(await find(driver,'#output'))).length
  const record=records[name]={selectedScript,expectedExitStatus:expected,beforeCount,status:'pending'}
  try{
    await clickControl(driver,'#run-script',30_000)
    const result=await waitFor(driver,async()=>extractFreshFrameworkScriptResult(await driver.text(await driver.find('#output')),beforeCount),{timeoutMs:30_000,description:`fresh ${name} test result`})
    Object.assign(record,result,{afterCount:beforeCount+1,status:result.exitStatus===expected?'passed':'failed'})
    if(result.exitStatus!==expected)throw Error(`Expected ${name} test exit ${expected}, received ${result.exitStatus}`)
    return record
  }catch(error){record.status='failed';record.error=String(error);throw error}
}
export async function assertSafariAppStopped(driver){
  await textIncludes(driver,'#output','App stopped',30_000)
  await waitFor(driver,()=>safariPreviewIsAbsent(driver),{timeoutMs:15_000,description:'preview shutdown'})
}
async function pageDiagnostics(driver){
  const read=async probe=>{try{return await probe()}catch(error){return `[unavailable: ${error.message}]`}}
  const preview=await read(async()=>{
    await driver.frame(await driver.find('#preview iframe'))
    return withSafariCleanup(()=>driver.execute(`return {readyState:document.readyState,message:document.querySelector('#message')?.textContent??null,heading:document.querySelector('h1')?.textContent??null,count:document.querySelector('#start-count')?.textContent??null,hydrated:document.querySelector('main')?.getAttribute('data-hydrated')??null,webSocketName:WebSocket.name,webSocketSource:String(WebSocket).slice(0,160)}`),()=>leavePreview(driver))
  })
  return {
    url:await read(()=>driver.url()),
    output:await read(async()=>driver.text(await driver.find('#output'))),
    openDisabled:await read(async()=>driver.attribute(await driver.find('#open'),'disabled')),
    owner:await read(()=>driver.execute('return {visibility:document.visibilityState,workers:globalThis.__safariWorkerCapacity?.snapshot()??null}')),
    preview,
  }
}

export function advanceSafariDocumentStability(state,sample,now=Date.now(),stableMs=5_000){
  if(!sample.ready||typeof sample.documentId!=='string')return {documentId:undefined,stableSince:0,ready:false}
  if(sample.documentId!==state.documentId)return {documentId:sample.documentId,stableSince:now,ready:false}
  return {documentId:state.documentId,stableSince:state.stableSince,ready:now-state.stableSince>=stableMs}
}

async function assertHeading(driver,kind,heading,{hydrated=false}={}){
  await enterPreview(driver)
  await withSafariCleanup(async()=>{
    await textIs(driver,kind==='vite'?'#message':'h1',heading)
    if(kind==='start'&&hydrated){
      let stability={documentId:undefined,stableSince:0,ready:false}
      await waitFor(driver,async()=>{
        const sample=await driver.execute(`return {
          heading:document.querySelector('h1')?.textContent??null,
          hydrated:document.querySelector('main')?.getAttribute('data-hydrated')??null,
          documentId:globalThis.__safariAcceptanceDocumentId??=(crypto.randomUUID?.()??String(Date.now())+'-'+Math.random()),
        }`)
        stability=advanceSafariDocumentStability(stability,{documentId:sample.documentId,ready:sample.heading===heading&&sample.hydrated==='true'})
        return stability.ready
      },{timeoutMs:90_000,description:'stable Start hydration'})
    }
  },()=>leavePreview(driver))
}
export function installSafariPointerProbe(){
  const events=[]
  const visibility={initial:document.visibilityState,current:document.visibilityState,hiddenSeen:document.visibilityState!=='visible'}
  const visibilityListener=()=>{visibility.current=document.visibilityState;if(document.visibilityState!=='visible')visibility.hiddenSeen=true}
  const listener=event=>{
    if(events.length<16)events.push({type:event.type,trusted:event.isTrusted,target:event.target?.id??null,time:performance.now()})
  }
  const types=['pointerdown','pointerup','mousedown','mouseup','click']
  for(const type of types)document.addEventListener(type,listener,{capture:true,passive:true})
  document.addEventListener('visibilitychange',visibilityListener,{capture:true,passive:true})
  globalThis.__safariAcceptancePointerProbe={events,visibility,dispose:()=>{for(const type of types)document.removeEventListener(type,listener,true);document.removeEventListener('visibilitychange',visibilityListener,true)}}
  return {documentId:globalThis.__safariAcceptanceDocumentId??null,visibility}
}
export function assertSafariPointerVisibility(visibility){
  if(!visibility||visibility.initial!=='visible'||visibility.current!=='visible'||visibility.hiddenSeen!==false){
    throw Object.assign(Error('Safari was not continuously visible during the trusted interaction. Unlock the Mac and keep the Safari automation window visible.'),{code:'ERR_SAFARI_NOT_VISIBLE'})
  }
}
async function assertApp(driver,kind,heading,serverProbe){
  await assertHeading(driver,kind,heading,{hydrated:true})
  if(kind!=='start')return
  await enterPreview(driver)
  await withSafariCleanup(async()=>{
    const count=await driver.find('#start-count')
    const pointerBefore=await driver.execute(`return (${installSafariPointerProbe.toString()})()`)
    try{
      assertSafariPointerVisibility(pointerBefore.visibility)
      await driver.pointerClick(count)
      await textIs(driver,'#start-count','Count: 1',15_000)
      assertSafariPointerVisibility(await driver.execute('return globalThis.__safariAcceptancePointerProbe?.visibility??null'))
    }catch(error){
      try{
        const evidence=await driver.execute(`
          const element=document.querySelector('#start-count'),rect=element?.getBoundingClientRect()
          return {events:globalThis.__safariAcceptancePointerProbe?.events??null,visibility:document.visibilityState,visibilityHistory:globalThis.__safariAcceptancePointerProbe?.visibility??null,focused:document.hasFocus(),count:element?.textContent??null,documentId:globalThis.__safariAcceptanceDocumentId??null,rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,hit:rect?document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.id??null:null}
        `)
        if(evidence.visibility!=='visible'||evidence.visibilityHistory?.hiddenSeen){
          error.code='ERR_SAFARI_NOT_VISIBLE'
          error.message='Safari lost visibility during the trusted interaction. '+error.message
        }
        error.message+='\nSafari trusted-pointer evidence: '+JSON.stringify({before:pointerBefore,after:evidence})
      }catch(diagnosticError){error.message+='\nSafari trusted-pointer evidence unavailable: '+String(diagnosticError)}
      throw error
    }finally{
      await driver.execute('globalThis.__safariAcceptancePointerProbe?.dispose();delete globalThis.__safariAcceptancePointerProbe').catch(()=>{})
    }
    if(serverProbe)await driver.execute(`(${installSafariPreviewLiveness.toString()})(arguments[0],arguments[1],true);return true`,[serverProbe.ownerOrigin,heading])
    await driver.pointerClick(await driver.find('#server-call'));await textIncludes(driver,'#server-reply','"method":"POST"',30_000)
  },()=>leavePreview(driver))
}

async function assertStartCount(driver,expected){
  await enterPreview(driver)
  await withSafariCleanup(()=>textIs(driver,'#start-count',expected,15_000),()=>leavePreview(driver))
}

async function capacitySnapshot(driver){
  const value=await driver.executeAsync(`
    const done=arguments[arguments.length-1]
    const probe=globalThis.__safariAcceptanceCapacity
    if(!probe){done({error:'Safari capacity probe is unavailable'});return}
    probe.snapshot().then(done,error=>done({error:String(error)}))
  `)
  if(value?.error)throw Error(value.error)
  return value
}

async function closeAndVerifyCapacity(driver,phase){
  const before=await capacitySnapshot(driver)
  await driver.execute(`
    const probe=globalThis.__safariAcceptanceCapacity
    if(!probe)throw Error('Safari capacity probe is unavailable')
    probe.close()
    return true
  `)
  const cleanup=await waitFor(driver,async()=>{
    const value=await driver.execute('return globalThis.__safariAcceptanceCapacity?.cleanup()')
    return value?.status==='pending'?false:value
  },{timeoutMs:90_000,description:`${phase} kernel shutdown`})
  if(cleanup.status==='failed')throw Error(`${phase} kernel shutdown failed: ${cleanup.error}`)
  if(cleanup.status!=='passed')throw Error(`${phase} kernel shutdown did not complete`)
  const workers=await driver.execute('return globalThis.__safariWorkerCapacity?.snapshot()')
  const evidence={beforeClose:before,afterClose:{workers,cleanup}}
  const fail=message=>{throw Object.assign(Error(message),{capacityEvidence:evidence})}
  if(!workers||workers.created<1)fail(`${phase} capacity probe did not observe the SDK owner worker`)
  if(workers.active!==0)fail(`${phase} left ${workers.active} SDK owner worker(s) active`)
  if(workers.released!==workers.created)fail(`${phase} released ${workers.released} of ${workers.created} SDK owner workers`)
  return evidence
}

async function runWorkflow(driver,identity,kind,{instrumentCapacity=true,requireVisible=true,postWorkflowIdleMs=0,traceInstall=false,tracePreviewServerCall=false}={}){
  const serverModule=await import(pathToFileURL(join(identity.sdkRoot,'examples/frameworks/server.mjs')).href)
  const host=await serverModule.startExample({ownerPort:0,previewPort:0}),proxy=await startSafariFrameworkProxy(host.ownerOrigin,{instrumentCapacity,traceInstall})
  const outcomes={cold:{status:'unverified',tests:{},edits:[]},resume:{status:'unverified',tests:{},edits:[]}},capacity={stages:[]},stage=value=>capacity.stages.push({value,at:Date.now()})
  try{
    await driver.navigate(proxy.origin);stage('owner navigated')
    if(requireVisible&&await driver.execute('return document.visibilityState')!=='visible')throw Object.assign(Error('Safari acceptance owner is not visible. Unlock the Mac and keep the Safari automation window visible.'),{code:'ERR_SAFARI_NOT_VISIBLE'})
    await textIs(driver,'#output','Choose a project to install or resume.',15_000)
    await chooseProject(driver,kind);stage('cold project selected')
    await clickControl(driver,'#open',15_000);stage('cold open clicked')
    await assertApp(driver,kind,kind==='vite'?'Hello from Vite':'Bare-bones Start');stage('cold app verified')
    const original=String(await driver.property(await find(driver,'#source'),'value'))
    await runSafariFrameworkScript(driver,0,outcomes.cold.tests,'initial')
    const negative=await setSource(driver,source=>kind==='vite'?'export const message = "";':source.replace('id="start-count"','id="removed"'))
    outcomes.cold.edits.push({name:'negative',source:negative})
    if(kind==='start'){
      await clickControl(driver,'#apply')
      await enterPreview(driver)
      await withSafariCleanup(()=>find(driver,'#removed'),()=>leavePreview(driver))
      outcomes.cold.edits.at(-1).observedSelector='#removed'
    }
    await runSafariFrameworkScript(driver,1,outcomes.cold.tests,'negative')
    const edited=kind==='vite'?'Safari WebDriver Vite':'Safari WebDriver Start'
    const editedSource=await setSource(driver,()=>original.replace(kind==='vite'?'Hello from Vite':'Bare-bones Start',edited))
    outcomes.cold.edits.push({name:'restored',source:editedSource})
    if(traceInstall&&kind==='start'){
      await driver.execute(`(${installSafariPreviewCollector.toString()})(document.querySelector('#preview iframe'),arguments[0]);return true`,[host.previewOrigin])
      await enterPreview(driver)
      await withSafariCleanup(()=>driver.execute(`(${installSafariPreviewLiveness.toString()})(arguments[0],arguments[1]);return true`,[proxy.origin,edited]),()=>leavePreview(driver))
      stage('preview liveness probe installed before edit')
    }
    await clickControl(driver,'#apply');stage('cold edit applied')
    await assertHeading(driver,kind,edited,{hydrated:true});stage('cold edit verified')
    outcomes.cold.edits.at(-1).observedHeading=edited
    if(kind==='start')await assertStartCount(driver,'Count: 1')
    await runSafariFrameworkScript(driver,0,outcomes.cold.tests,'restoredEdited')
    await clickControl(driver,'#save');stage('cold save clicked')
    await textIncludes(driver,'#output','Saved.',30_000);stage('cold save completed')
    if(instrumentCapacity)capacity.cold=await closeAndVerifyCapacity(driver,`${kind} cold`)
    stage('cold capacity verified')
    Object.assign(outcomes.cold,{status:'passed',evidence:['install','preview','live edit','user interaction','initial test','negative test','restored edited test','save']})
    await fetch(proxy.origin+'/__test/network?mode=offline',{method:'POST'});stage('offline policy enabled')
    await driver.refresh();stage('owner refreshed')
    await textIs(driver,'#output','Choose a project to install or resume.',15_000);stage('resumed owner ready')
    await chooseProject(driver,kind);stage('resume project selected')
    await clickControl(driver,'#resume',15_000);stage('resume clicked')
    if(tracePreviewServerCall&&kind==='start')await driver.execute(`(${installSafariPreviewCollector.toString()})(document.querySelector('#preview iframe'),arguments[0]);return true`,[host.previewOrigin])
    await assertApp(driver,kind,edited,tracePreviewServerCall&&kind==='start'?{ownerOrigin:proxy.origin}:undefined);stage('resumed app verified')
    await runSafariFrameworkScript(driver,0,outcomes.resume.tests,'restored')
    const resumedHeading=edited+' resumed edit'
    const resumedSource=await setSource(driver,source=>source.replace(edited,resumedHeading))
    outcomes.resume.edits.push({name:'newAfterResume',source:resumedSource})
    await clickControl(driver,'#apply');stage('resume edit applied')
    await assertHeading(driver,kind,resumedHeading,{hydrated:true});stage('resume edit verified')
    outcomes.resume.edits.at(-1).observedHeading=resumedHeading
    await runSafariFrameworkScript(driver,0,outcomes.resume.tests,'newEdited')
    await clickControl(driver,'#stop');stage('resume stop clicked')
    await assertSafariAppStopped(driver)
    outcomes.resume.stopped={output:await driver.text(await driver.find('#output')),previewAbsent:true}
    if(instrumentCapacity)capacity.resume=await closeAndVerifyCapacity(driver,`${kind} resume`)
    stage('resume capacity verified')
    if(postWorkflowIdleMs>0)capacity.postWorkflowIdle=await sampleSafariPostWorkflowIdle(postWorkflowIdleMs)
    Object.assign(outcomes.resume,{status:'passed',evidence:['owner reload','offline policy','restore','preview','user interaction','restored test','new live edit','new edited test','App stopped']})
    return {outcomes,capacity}
  }catch(error){
    const phase=outcomes.cold.status==='passed'?'resume':'cold'
    if(error.capacityEvidence)capacity[phase]=error.capacityEvidence
    capacity.ownerRequestsAtFailure=proxy.requestLedgerSnapshot()
    const diagnostics=await pageDiagnostics(driver)
    if(instrumentCapacity)capacity.samples=proxy.capacitySamples.slice()
    Object.assign(outcomes[phase],{status:'failed',evidence:[String(error),JSON.stringify(diagnostics)]})
    error.message+=`\nSafari page diagnostics: ${JSON.stringify(diagnostics)}`
    Object.assign(error,{workflowOutcomes:outcomes,workflowCapacity:capacity})
    throw error
  }finally{
    capacity.ownerRequests=proxy.requestLedgerSnapshot()
    await proxy.close();await host.close()
  }
}

async function probeSafariRecovery(driverBinary){
  let driverProcess,driver,safariPID
  try{
    assertSafariAutomationAvailable()
    const started=await startSafariDriver({binary:driverBinary});driverProcess=started.child;driver=started.driver
    const capabilities=await driver.createSession()
    await driver.maximizeWindow()
    safariPID=(await activateSafariAutomation()).pid
    await driver.navigate('about:blank')
    const answer=await driver.execute('return 21*2')
    if(answer!==42)throw Error(`Safari recovery probe returned ${JSON.stringify(answer)}`)
    return {status:'passed',classification:'fresh-safari-session-available',browserVersion:capabilities.browserVersion??capabilities.version??null}
  }catch(error){return {status:'failed',classification:'safari-process-or-automation-unavailable',error:String(error),code:error.code}}
  finally{await driver?.close();await stopSafariDriver(driverProcess);if(safariPID)await stopSafariAutomationProcess(safariPID)}
}

export function retainSafariDriverStderr(readStderr){
  if(!readStderr)return {available:false,limitCharacters:16384}
  return {available:true,limitCharacters:16384,stderr:readStderr().slice(-16384)}
}

export async function runSafariFrameworkAcceptance({sdkRoot,tarball,output,expected={},driverBinary='/usr/bin/safaridriver',requiredRepetitions=3,workflows=['vite','start'],instrumentCapacity=true,requireVisible=true,postWorkflowIdleMs=0,traceInstall=false,tracePreviewServerCall=false}={}){
  if(traceInstall&&!instrumentCapacity)throw Error('Install tracing requires capacity observation')
  if(tracePreviewServerCall&&!instrumentCapacity)throw Error('Preview server-call tracing requires capacity observation')
  if(!Number.isInteger(requiredRepetitions)||requiredRepetitions<2)throw Error('Safari acceptance requires at least two repetitions')
  if(!Array.isArray(workflows)||workflows.length<1||workflows.some(name=>!['vite','start'].includes(name))||new Set(workflows).size!==workflows.length)throw Error('Safari acceptance workflows must be a unique subset of vite and start')
  const artifactIdentity=readSafariArtifactIdentity({sdkRoot,tarball,expected})
  const identity=installSafariAcceptanceConsumer(artifactIdentity),startedAt=new Date().toISOString(),rounds=[]
  let capabilities,failure
  try{
    assertSafariAutomationAvailable()
    acceptance: for(let index=0;index<requiredRepetitions;index++){
      const results=emptyResults(),round={index:index+1,results,capacity:{}}
      rounds.push(round)
      for(const kind of workflows){
        console.error(`Safari round ${index+1}/${requiredRepetitions}: ${kind} starting`)
        let driverProcess,driver,safariPID,readDriverStderr
        try{
          assertSafariAutomationAvailable()
          const started=await startSafariDriver({binary:driverBinary});driverProcess=started.child;driver=started.driver;readDriverStderr=started.stderr
          const currentCapabilities=await driver.createSession()
          await driver.maximizeWindow()
          safariPID=(await activateSafariAutomation()).pid
          if(!capabilities)capabilities=currentCapabilities
          else if(currentCapabilities.browserVersion!==capabilities.browserVersion)throw Error('Safari version changed during acceptance')
          const workflow=await runWorkflow(driver,identity,kind,{instrumentCapacity,requireVisible,postWorkflowIdleMs,traceInstall,tracePreviewServerCall})
          results[kind]=workflow.outcomes
          round.capacity[kind]=workflow.capacity
          console.error(`Safari round ${index+1}/${requiredRepetitions}: ${kind} cold=${workflow.outcomes.cold.status}, resume=${workflow.outcomes.resume.status}`)
        }catch(error){
          results[kind]=error.workflowOutcomes??{cold:{status:'failed',evidence:[String(error)]},resume:{status:'unverified'}}
          round.capacity[kind]=error.workflowCapacity??{}
          failure={name:error.name,message:error.message,code:error.code,round:index+1,workflow:kind}
          console.error(`Safari round ${index+1}/${requiredRepetitions}: ${kind} failed (${error.code??error.name})`)
        }finally{
          round.driverDiagnostics??={}
          round.driverDiagnostics[kind]={beforeCleanup:retainSafariDriverStderr(readDriverStderr)}
          await driver?.close();await stopSafariDriver(driverProcess);if(safariPID)await stopSafariAutomationProcess(safariPID)
          round.driverDiagnostics[kind].afterCleanup=retainSafariDriverStderr(readDriverStderr)
        }
        if(failure){
          failure.recovery=await probeSafariRecovery(driverBinary)
          failure.classification=classifySafariCapacityFailure(failure.code,failure.recovery)
          break acceptance
        }
      }
    }
  }catch(error){failure={name:error.name??'Error',message:error.message??String(error),...(error.code?{code:error.code}:{})}}
  const results=aggregateResults(rounds,requiredRepetitions)
  const evidence=createSafariEvidence({identity:artifactIdentity,capabilities,startedAt,finishedAt:new Date().toISOString(),requiredRepetitions,rounds,results,failure})
  if(traceInstall)Object.assign(evidence,{passed:false,diagnosticOnly:true,workerPrefixSHA256:hash(safariInstallStageTraceSource)})
  if(tracePreviewServerCall)Object.assign(evidence,{passed:false,diagnosticOnly:true,previewServerCallProbe:true})
  const reportPath=resolve(output)
  mkdirSync(dirname(reportPath),{recursive:true})
  writeFileSync(reportPath,JSON.stringify(evidence,null,2)+'\n')
  return evidence
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(!process.env.SDK_OUTPUT||!process.env.SDK_TARBALL)throw Error('Set SDK_OUTPUT and SDK_TARBALL to the exact packaged candidate')
  const output=resolve(process.env.SAFARI_ACCEPTANCE_REPORT??'reports/safari-framework-acceptance.json')
  const expected={manifestSHA256:process.env.SDK_MANIFEST_SHA256,buildProfile:process.env.SDK_BUILD_PROFILE,tarballSHA256:process.env.SDK_TARBALL_SHA256}
  const workflows=process.env.SAFARI_ACCEPTANCE_WORKFLOWS?.split(',').filter(Boolean)
  const instrumentCapacity=process.env.SAFARI_ACCEPTANCE_CAPACITY!=='0'
  const requireVisible=process.env.SAFARI_ACCEPTANCE_REQUIRE_VISIBLE!=='0'
  const postWorkflowIdleMs=Number(process.env.SAFARI_ACCEPTANCE_POST_WORKFLOW_IDLE_MS??0)
  const traceInstall=process.env.SAFARI_INSTALL_STAGE_TRACE==='1'
  const tracePreviewServerCall=process.env.SAFARI_PREVIEW_SERVER_CALL_TRACE==='1'
  const evidence=await runSafariFrameworkAcceptance({sdkRoot:process.env.SDK_OUTPUT,tarball:process.env.SDK_TARBALL,output,expected,driverBinary:process.env.SAFARIDRIVER_BINARY,instrumentCapacity,requireVisible,postWorkflowIdleMs,traceInstall,tracePreviewServerCall,...(workflows?{workflows}:{})})
  console.log(JSON.stringify({passed:evidence.passed,failure:evidence.failure,report:output,artifact:evidence.artifact}))
  if(!evidence.passed)process.exitCode=1
}
