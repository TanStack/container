import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {resolve} from 'node:path'
import {build} from 'esbuild'
import {activateSafariAutomation,assertSafariAutomationAvailable,startSafariDriver,stopSafariAutomationProcess,stopSafariDriver} from './safari-webdriver.mjs'
import {prepareSafariEsbuildProbe} from './safari-esbuild-probe-assets.mjs'

const wait=milliseconds=>new Promise(resolveWait=>setTimeout(resolveWait,milliseconds))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function webContentProcesses(){
  const result=spawnSync('/bin/ps',['ax','-o','pid=,rss=,comm='],{encoding:'utf8'})
  if(result.status!==0)throw Error(`Could not inspect WebContent processes: ${result.stderr}`)
  return result.stdout.split('\n').flatMap(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return match&&match[3].includes('/com.apple.WebKit.WebContent')?[{pid:Number(match[1]),residentKiB:Number(match[2])}]:[]})
}
async function startServer(sdkRoot,capturePath){
  const owner=await build({entryPoints:['tests/fixtures/browser-compiler-runner-owner.mjs'],bundle:true,format:'esm',platform:'browser',write:false})
  const worker=await build({entryPoints:['src/compiler/browser-compiler.worker.ts'],bundle:true,format:'iife',platform:'browser',write:false})
  const originalCompiler=readFileSync(resolve(sdkRoot,'runtime/compiler/esbuild.wasm'))
  const preparedCompiler=prepareSafariEsbuildProbe(originalCompiler)
  const captureBytes=capturePath?readFileSync(capturePath):null
  const assets=new Map([
    ['/runner-owner.js',['text/javascript',owner.outputFiles[0].contents]],
    ['/runner-worker.js',['text/javascript',worker.outputFiles[0].contents]],
    ['/wasm_exec.js',['text/javascript',readFileSync(resolve('node_modules/esbuild-wasm/wasm_exec.js'))]],
    ['/compiler.wasm',['application/wasm',preparedCompiler.bytes]],
    ...(captureBytes?[[ '/captures.json',['application/json',captureBytes] ]]:[]),
  ])
  const server=createServer((request,response)=>{
    const asset=assets.get(request.url??'')
    if(asset){response.writeHead(200,{'Content-Type':asset[0],'Cache-Control':'no-store'});response.end(asset[1]);return}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'})
    response.end(`<!doctype html><title>Safari esbuild workload memory probe</title><script type="module">
      const parameters=new URL(location.href).searchParams
      const cycles=Number(parameters.get('cycles'))
      const captured=parameters.get('captured')==='1'
      const state=globalThis.__esbuildProbe={status:'starting',completed:0,error:null,startedAt:performance.now(),results:[]}
      ;(async()=>{try{
        const {runRunnerWorkflow,runCapturedTransformWorkflow}=await import('/runner-owner.js')
        state.status='running'
        if(captured){
          const captures=await(await fetch('/captures.json')).json()
          const result=await runCapturedTransformWorkflow(captures,2)
          if(result.result.code!==0||!result.handshake||result.pending!==0||result.outputs.length!==30)throw Error('Unexpected captured compiler result: '+JSON.stringify(result))
          state.results.push({code:result.result.code,resources:result.resources,outputs:result.outputs})
          state.completed=result.outputs.length
        }else{
          for(let index=0;index<cycles;index++){
            const result=await runRunnerWorkflow()
            if(JSON.stringify(result.values)!=='[42,43]'||result.result.code!==0||!result.handshake||result.pending!==0)throw Error('Unexpected compiler result: '+JSON.stringify(result))
            state.results.push({values:result.values,code:result.result.code,resources:result.resources})
            state.completed=index+1
            await new Promise(resolve=>setTimeout(resolve,0))
          }
        }
        state.durationMs=performance.now()-state.startedAt
        state.status='passed'
      }catch(error){state.status='failed';state.error=String(error);state.stack=error?.stack}})()
    </script>`)
  })
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen)})
  return {assets,compiler:{original:{bytes:originalCompiler.length,sha256:hash(originalCompiler)},prepared:{bytes:preparedCompiler.bytes.length,sha256:hash(preparedCompiler.bytes),minPages:preparedCompiler.minPages,maxPages:preparedCompiler.declaredMaxPages}},origin:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise((resolveClose,reject)=>server.close(error=>error?reject(error):resolveClose()))}
}

if(!process.env.SDK_OUTPUT)throw Error('Set SDK_OUTPUT to the exact packaged SDK directory')
const sdkRoot=resolve(process.env.SDK_OUTPUT)
const output=resolve(process.env.SAFARI_ESBUILD_REPORT??'reports/safari-esbuild-workload-memory.json')
const capturePath=process.env.SAFARI_ESBUILD_CAPTURE_PATH?resolve(process.env.SAFARI_ESBUILD_CAPTURE_PATH):null
const captureBytes=capturePath?readFileSync(capturePath):null
const cycles=Number(process.env.SAFARI_ESBUILD_CYCLES??10)
if(!Number.isInteger(cycles)||cycles<1||cycles>20)throw Error('SAFARI_ESBUILD_CYCLES must be from 1 through 20')
const host=await startServer(sdkRoot,capturePath)
let driverProcess,driver
const report={format:1,startedAt:new Date().toISOString(),sdkRoot,browserVersion:null,safariPID:null,cycles,stage:'starting',compiler:host.compiler,capture:capturePath?{path:capturePath,bytes:captureBytes.length,sha256:hash(captureBytes),expectedCompilerVersion:'0.28.2',count:JSON.parse(captureBytes).length,rounds:2,provenance:'archived clean-source Start compiler capture fixture',graphDisclosure:'The capture records transform inputs and options, not its complete npm dependency graph. It uses the same esbuild 0.28.2 service protocol as the exact SDK artifact, but this diagnostic does not claim the captured Start package graph is identical to the final acceptance fixture.'}:null,assets:Object.fromEntries([...host.assets].map(([name,[,bytes]])=>[name.slice(1),{bytes:bytes.length,sha256:hash(bytes)}])),samples:[]}
try{
  assertSafariAutomationAvailable()
  const started=await startSafariDriver({});driverProcess=started.child;driver=started.driver
  const capabilities=await driver.createSession();report.browserVersion=capabilities.browserVersion??capabilities.version??null
  await driver.maximizeWindow();report.safariPID=(await activateSafariAutomation()).pid
  report.stage='navigating'
  await driver.navigate(`${host.origin}/?cycles=${cycles}${capturePath?'&captured=1':''}`)
  report.stage='sampling'
  const deadline=Date.now()+120_000
  while(Date.now()<deadline){
    const state=await driver.execute('const s=globalThis.__esbuildProbe; return s&&{status:s.status,completed:s.completed,error:s.error,stack:s.stack,durationMs:s.durationMs,last:s.results?.at(-1)}')
    report.samples.push({at:new Date().toISOString(),state,processes:webContentProcesses()})
    if(state?.status==='passed'||state?.status==='failed')break
    await wait(1_000)
  }
  report.result=report.samples.at(-1)?.state
  if(!report.result||!['passed','failed'].includes(report.result.status))report.result={status:'timeout'}
  await wait(10_000);report.afterSettleProcesses=webContentProcesses()
  report.stage='complete'
  if(report.result.status!=='passed')throw Error(`Safari esbuild workload ${report.result.status}: ${report.result.error??'no terminal state'}`)
}catch(error){
  report.failure={name:error?.name??'Error',message:error?.message??String(error),code:error?.code}
  if(!report.result)report.result={status:'harness-failed',stage:report.stage}
  throw error
}finally{
  report.finishedAt=new Date().toISOString();writeFileSync(output,JSON.stringify(report,null,2)+'\n')
  await driver?.close();await stopSafariDriver(driverProcess);if(report.safariPID)await stopSafariAutomationProcess(report.safariPID);await host.close()
}
console.log(output)
