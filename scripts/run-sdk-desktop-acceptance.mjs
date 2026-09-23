import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {closeSync,lstatSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const usage='Usage: node scripts/run-sdk-desktop-acceptance.mjs --sdk SDK_DIRECTORY --output NEW_DIRECTORY [--browsers chromium,firefox] [--manifest-sha256 HASH]'

export function parseDesktopAcceptanceArgs(args){
  const values={}
  for(let index=0;index<args.length;index++){
    const [name,...inline]=args[index].split('=')
    if(!['--sdk','--output','--browsers','--manifest-sha256'].includes(name)||Object.hasOwn(values,name))throw Error(usage)
    const value=inline.length?inline.join('='):args[++index]
    if(!value||value.startsWith('--'))throw Error(usage)
    values[name]=value
  }
  if(!values['--sdk']||!values['--output'])throw Error(usage)
  return {sdk:values['--sdk'],output:values['--output'],browsers:(values['--browsers']??'chromium,firefox').split(','),manifestSHA256:values['--manifest-sha256']}
}

export function assertPlainDesktopEnvironment(env){
  const blocked=Object.entries(env).filter(([key,value])=>value!==undefined&&value!==''&&(
    /^(SDK|SAFARI)_.*(TRACE|PROFILE|CAPTURE)/.test(key)&&key!=='SDK_BUILD_PROFILE'||
    /^(MOZ_PROFILER|MOZ_LOG|JS_TRACE|PWDEBUG)/.test(key)||
    key==='SDK_FRAMEWORK_EXAMPLE_SOURCE'||key==='PLAYWRIGHT_TEST_ARGS'
  )).map(([key])=>key)
  if(blocked.length)throw Error('Plain desktop acceptance requires these tracing or override variables to be unset: '+blocked.join(', '))
}

export function inspectDesktopAcceptanceSDK(sdk,expectedHash){
  const path=join(sdk,'manifest.json'),stat=lstatSync(path)
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('SDK manifest must be a regular file')
  const bytes=readFileSync(path),manifestSHA256=hash(bytes),manifest=JSON.parse(bytes)
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||typeof manifest.buildProfile!=='string')throw Error('SDK manifest is missing its build profile')
  if(expectedHash!==undefined&&(!/^[a-f0-9]{64}$/.test(expectedHash)||manifestSHA256!==expectedHash))throw Error('SDK manifest SHA256 does not match the expected artifact')
  if(/sampling|fairness|diagnostic|profil/i.test(manifest.buildProfile))throw Error('Diagnostic SDK build profiles cannot be used for plain acceptance: '+manifest.buildProfile)
  for(const [slot,engine] of Object.entries(manifest.engines??{})){
    const metadata=engine?.metadata??{}
    if(metadata.guestSampling||metadata.fibers?.fairness||metadata.sortDiagnostics||metadata.wasmMemoryDiagnostics||/guest-sampling|fiber-fairness|diagnostic/.test(engine?.sourceDirectory??''))throw Error('Diagnostic SDK engine cannot be used for plain acceptance: '+slot)
  }
  const server=lstatSync(join(sdk,'examples/frameworks/server.mjs'))
  if(!server.isFile()||server.isSymbolicLink())throw Error('SDK is missing its packaged framework example')
  return {manifestSHA256,buildProfile:manifest.buildProfile}
}

export function runCommand(command,args,{cwd,env,log},spawnProcess=spawn){
  return new Promise((resolveRun,reject)=>{
    const fd=openSync(log,'wx')
    let settled=false
    const settle=(error,result)=>{
      if(settled)return
      settled=true
      try{closeSync(fd)}catch(closeError){error??=closeError}
      if(error)reject(error)
      else resolveRun(result)
    }
    let child
    try{child=spawnProcess(command,args,{cwd,env,stdio:['ignore',fd,fd]})}
    catch(error){settle(error);return}
    child.once('error',error=>settle(error))
    child.once('exit',(code,signal)=>settle(undefined,{code,signal}))
  })
}

export async function runDesktopAcceptance(options,{env=process.env,execute=runCommand,notify=message=>console.log(message)}={}){
  const {sdk:inputSDK,output:inputOutput,browsers=['chromium','firefox'],manifestSHA256:expectedHash}=options
  if(typeof inputSDK!=='string'||!inputSDK||typeof inputOutput!=='string'||!inputOutput)throw Error(usage)
  if(!Array.isArray(browsers)||!browsers.length||new Set(browsers).size!==browsers.length||browsers.some(browser=>!['chromium','firefox'].includes(browser)))throw Error('Choose chromium and/or firefox once each, in run order. WebKit is not Safari acceptance.')
  assertPlainDesktopEnvironment(env)
  const sdk=resolve(inputSDK),output=resolve(inputOutput),identity=inspectDesktopAcceptanceSDK(sdk,expectedHash)
  const cli=join(repository,'node_modules/@playwright/test/cli.js')
  if(!lstatSync(cli).isFile())throw Error('Local Playwright CLI is missing')
  // Do not reuse any existing output, including an empty directory or symlink.
  mkdirSync(output)
  const report={format:1,scope:'command execution only; paired workflow reports still require validation; not Safari',sdk,output,...identity,repeatEach:3,workers:1,browsers:[...browsers],status:'running',startedAt:new Date().toISOString(),runs:[]}
  const reportPath=join(output,'report.json'),save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n')
  save()
  try{
    for(const browser of browsers){
      inspectDesktopAcceptanceSDK(sdk,identity.manifestSHA256)
      const args=[cli,'test','tests/sdk/framework-example.spec.mjs','--config=playwright.sdk.config.ts',`--project=${browser}`,'--repeat-each=3','--workers=1','--retries=0',`--output=${join(output,browser)}`,'--reporter=line,json']
      const run={browser,command:process.execPath,args,manifestSHA256:identity.manifestSHA256,status:'running',startedAt:new Date().toISOString(),log:join(output,browser+'.log')}
      report.runs.push(run);save();notify(`Started ${browser}: ${JSON.stringify([run.command,...args])} (manifest ${identity.manifestSHA256})`)
      try{
        const result=await execute(run.command,args,{cwd:repository,env:{...env,SDK_OUTPUT:sdk,PLAYWRIGHT_JSON_OUTPUT_FILE:join(output,browser+'.json')},log:run.log})
        run.exitCode=result.code;run.signal=result.signal??null
        run.status=result.code===0&&!result.signal?'passed':'failed'
      }catch(error){run.status='failed';run.exitCode=null;run.error=String(error)}
      run.completedAt=new Date().toISOString();save()
      notify(`Completed ${browser}: ${run.status}, exit ${run.exitCode}, manifest ${identity.manifestSHA256}`)
      if(run.status!=='passed'){report.status='failed';break}
      inspectDesktopAcceptanceSDK(sdk,identity.manifestSHA256)
    }
    if(report.status==='running')report.status='passed'
  }catch(error){report.status='failed';report.error=String(error)}
  report.completedAt=new Date().toISOString();save()
  return report
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const report=await runDesktopAcceptance(parseDesktopAcceptanceArgs(process.argv.slice(2)))
    console.log(JSON.stringify({status:report.status,scope:report.scope,manifestSHA256:report.manifestSHA256,report:join(report.output,'report.json')}))
    if(report.status!=='passed')process.exitCode=1
  }catch(error){console.error(error.message);process.exitCode=1}
}
