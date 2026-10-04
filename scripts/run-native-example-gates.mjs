#!/usr/bin/env node
import {spawn,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createWriteStream,existsSync,mkdtempSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {declaredBuildEvidence} from './native-cli-evidence.mjs'
import {verifyFixtureToolchain} from './native-fixture-toolchain.mjs'
import {nativeGateCellTimeout,nativeGateTestArguments} from './native-gate-cell.mjs'

const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
const cellTimeout=nativeGateCellTimeout(process.env.NATIVE_GATE_CELL_TIMEOUT_MS)
const contract=JSON.parse(readFileSync(new URL('../integrations/tanstack-four-examples/contract.json',import.meta.url),'utf8'))
const flags={
  'start-counter':'NATIVE_REAL_COUNTER',
  'start-basic':'NATIVE_REAL_START_BASIC',
  'start-streaming-data-from-server-functions':'NATIVE_REAL_START_STREAMING',
  'basic-ssr-file-based':'NATIVE_REAL_ROUTER_ENTRY',
  'solid-start-counter':'NATIVE_REAL_SOLID_COUNTER',
}
const examples=[...contract.examples.map(example=>example.id),'solid-start-counter']
const usage='Usage: node scripts/run-native-example-gates.mjs --runtime DIR [--source ROUTER_DIR] [--example ID|all] [--browser chromium|firefox|webkit|all] [--mode dev|production|both] [--repeat 1..100] [--output NEW_DIR]'
const options={browser:'all',mode:'both',example:'all',source:process.env.TANSTACK_ROUTER_SOURCE??resolve(root,'../router')}
for(let index=2;index<process.argv.length;index+=2){
  const name=process.argv[index],value=process.argv[index+1]
  if(!name?.startsWith('--')||!value)throw Error(usage)
  if(!['runtime','source','example','browser','mode','output','repeat'].includes(name.slice(2)))throw Error(usage)
  options[name.slice(2)]=value
}
if(!options.runtime||!['all','chromium','firefox','webkit'].includes(options.browser)||!['dev','production','both'].includes(options.mode)||!['all',...examples].includes(options.example))throw Error(usage)
const repetitions=Number(options.repeat??1)
if(!Number.isInteger(repetitions)||repetitions<1||repetitions>100)throw Error(usage)
if(examples.some(id=>!flags[id]))throw Error('Native gate command does not cover every contracted example')
const runtime=resolve(options.runtime),source=resolve(options.source)
if(!existsSync(join(runtime,'engine.js'))||!existsSync(join(runtime,'esbuild.wasm')))throw Error('Native runtime bundle is incomplete: '+runtime)
if(!existsSync(join(source,'examples/react/start-counter/package.json')))throw Error('TanStack Router example source is missing: '+source)
const output=options.output?resolve(options.output):mkdtempSync(join(tmpdir(),'native-example-gates-'))
if(options.output)mkdirSync(output)
const revision=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
const sourceDirty=Boolean(execFileSync('git',['-C',source,'status','--porcelain'],{encoding:'utf8'}).trim())
const engineSHA256=createHash('sha256').update(readFileSync(join(runtime,'engine.js'))).digest('hex')
const sdkBundle=process.env.NATIVE_SDK_BUNDLE_DIR?resolve(process.env.NATIVE_SDK_BUNDLE_DIR):undefined
const sdkBundleSHA256=sdkBundle?createHash('sha256').update(readFileSync(join(sdkBundle,'index.js'))).digest('hex'):undefined
const deployment=process.env.NATIVE_DEPLOYMENT_DIR?resolve(process.env.NATIVE_DEPLOYMENT_DIR):undefined
if(deployment){
  if(resolve(deployment,'runtime/native')!==runtime)throw Error('Runtime must come from NATIVE_DEPLOYMENT_DIR')
  if(!existsSync(join(deployment,'preview-host/__sandbox/bridge.html'))||!existsSync(join(deployment,'deployment-manifest.json')))
    throw Error('Native deployment is incomplete: '+deployment)
}
const browsers=options.browser==='all'?['chromium','firefox','webkit']:[options.browser]
const modes=options.mode==='both'?['dev','production']:[options.mode]
const rows=[]
const selectedExamples=options.example==='all'?examples:[options.example]
const fixtureNames={'start-counter':'native-real-counter','start-basic':'native-real-start-basic',
  'start-streaming-data-from-server-functions':'native-real-start-streaming','basic-ssr-file-based':'native-real-router-ssr',
  'solid-start-counter':'native-real-solid-counter'}
const shipped=JSON.parse(readFileSync(join(runtime,'SHIPPED-INPUTS.json'),'utf8'))
for(const id of selectedExamples)verifyFixtureToolchain(shipped,JSON.parse(readFileSync(join(root,'fixtures',fixtureNames[id],'package-lock.json'),'utf8')))
const plannedRows=selectedExamples.length*modes.length*browsers.length*repetitions
const saveProgress=(status,currentRow=null)=>{
  const temporary=join(output,'progress.json.tmp')
  writeFileSync(temporary,JSON.stringify({format:1,status,currentRow,plannedRows,completedRows:rows.length,
    runtime,engineSHA256,source,sourceRevision:revision,sourceDirty,cellTimeoutMs:cellTimeout,rows},null,2)+'\n')
  renameSync(temporary,join(output,'progress.json'))
}
let current
let interrupted=false
const interrupt=()=>{interrupted=true;current?.kill('SIGTERM')}
process.once('SIGINT',interrupt)
process.once('SIGTERM',interrupt)
saveProgress('running')
for(const id of selectedExamples){
  for(const mode of modes){
    for(const browser of browsers){
      for(let iteration=1;iteration<=repetitions;iteration++){
      if(interrupted)break
      const label=`${id}-${mode}-${browser}`+(repetitions>1?`-run-${iteration}`:''),logPath=join(output,label+'.log')
      saveProgress('running',label)
      const env={...process.env,
        NATIVE_VITE8_BUNDLE_DIR:runtime,TANSTACK_ROUTER_SOURCE:source,
        NATIVE_TEST_BROWSER:browser,NATIVE_PROJECT_SCRIPT:'1',
      }
      for(const flag of Object.values(flags))delete env[flag]
      for(const flag of ['NATIVE_REAL_BUILD','NATIVE_EXPECT_PRODUCTION_ENTRY','NATIVE_EXECUTE_PRODUCTION_ENTRY','NATIVE_PRODUCTION_PREVIEW','NATIVE_ROUTER_STATIC_ONLY'])delete env[flag]
      env[flags[id]]='1'
      if(mode==='production')Object.assign(env,{NATIVE_REAL_BUILD:'1',NATIVE_EXPECT_PRODUCTION_ENTRY:'1',NATIVE_EXECUTE_PRODUCTION_ENTRY:'1',NATIVE_PRODUCTION_PREVIEW:'1'})
      const started=Date.now(),log=createWriteStream(logPath,{flags:'wx'})
      process.stdout.write(`Running ${label}\n`)
      const result=await new Promise((resolveResult,reject)=>{
        const child=spawn(process.execPath,nativeGateTestArguments(cellTimeout,'tests/native-dev-server.test.mjs'),{cwd:root,env,stdio:['ignore','pipe','pipe']})
        current=child
        child.stdout.pipe(log,{end:false})
        child.stderr.pipe(log,{end:false})
        child.once('error',reject)
        child.once('close',(code,signal)=>resolveResult({code,signal}))
      }).finally(async()=>{current=undefined;await new Promise(resolve=>log.end(resolve))})
      const streamingDelivery=[...readFileSync(logPath,'utf8').matchAll(/STREAMING_DELIVERY (\{[^\n]+\})/g)].map(match=>JSON.parse(match[1]))
      const streamingVerified=id!=='start-streaming-data-from-server-functions'||
        ['Get 10 random numbers (ReadableStream)','Get 10 random numbers (Async Generator Function)'].every(label=>
          streamingDelivery.some(item=>item.label===label&&item.first?.count>0&&item.first.count<10&&item.completedMs>item.first.elapsedMs))
      const cliRequired=mode==='production'&&process.env.NATIVE_REAL_BUILD_CLI==='1'
      const cliEvidence=cliRequired?declaredBuildEvidence(readFileSync(logPath,'utf8')):[]
      const cliVerified=!cliRequired||cliEvidence.length>0
      const row={example:id,mode,browser,iteration,status:result.code===0&&streamingVerified&&cliVerified?'passed':'failed',exitCode:result.code,signal:result.signal,elapsedMs:Date.now()-started,log:logPath,
        ...(cliRequired?{cliVerified,cliEvidence}:{}),
        ...(id==='start-streaming-data-from-server-functions'?{streamingVerified,streamingDelivery}:{})}
      rows.push(row)
      saveProgress(interrupted?'interrupted':'running')
      process.stdout.write(`${row.status} ${label} (${(row.elapsedMs/1000).toFixed(1)}s)\n`)
      }
    }
  }
}
process.removeListener('SIGINT',interrupt)
process.removeListener('SIGTERM',interrupt)
const report={format:1,contract:contract.suiteId,source,sourceRevision:revision,sourceDirty,runtime,engineSHA256,
  ...(sdkBundle?{sdkBundle,sdkBundleSHA256}:{}),...(deployment?{deployment}:{}),
  checks:{declaredBuildScript:process.env.NATIVE_REAL_BUILD_SCRIPT==='1',declaredBuildCLI:process.env.NATIVE_REAL_BUILD_CLI==='1',typecheckOnly:process.env.NATIVE_REAL_TYPECHECK==='1',
    automaticProjectLock:process.env.NATIVE_AUTO_PROJECT_LOCK==='1',declaredCommands:process.env.NATIVE_DECLARED_COMMANDS==='1',
    productionPreview:modes.includes('production')},
  output,repetitions,plannedRows,cellTimeoutMs:cellTimeout,rows,
  note:'Solid Start counter is supplementary. It is not the new SolidJS site launch suite.'}
writeFileSync(join(output,'results.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'})
saveProgress(interrupted?'interrupted':'completed')
process.stdout.write(`Results: ${join(output,'results.json')}\n`)
if(interrupted||rows.some(row=>row.status!=='passed'))process.exitCode=1
