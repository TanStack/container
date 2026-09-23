import {createServer} from 'node:http'
import {createHash,randomBytes} from 'node:crypto'
import {readFileSync,readdirSync,realpathSync,mkdtempSync,writeFileSync,existsSync} from 'node:fs'
import {resolve,relative,sep,extname,dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn} from 'node:child_process'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {startSnapshotStore,fingerprintStartWorkspace} from '../tests/sdk-frameworks/start-workspace-persistence.ts'
import {runNativeStart,observeNativeStartReadiness,classifyNavigationCancellations} from './native-firefox-start-client.mjs'

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
export function prepareNativeStartFixture(source=resolve(repository,'../router/examples/react/start-counter')){
  source=realpathSync(source)
  const files={},hashes={}
  const collect=directory=>{for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(['node_modules','.git','dist','.output'].includes(entry.name))continue
    const path=join(directory,entry.name)
    if(entry.isDirectory()){collect(path);continue}
    if(!entry.isFile())throw Error('Unexpected source entry: '+path)
    const bytes=readFileSync(path),name=relative(source,path);files['/project/'+name]=bytes.toString();hashes[name]=hash(bytes)
  }}
  collect(source)
  const fixture=resolve(repository,'fixtures/site-start-counter-portable'),provenance=JSON.parse(readFileSync(join(fixture,'provenance.json'),'utf8'))
  if(hashes['package.json']!==provenance.sourceSHA256)throw Error('Actual site manifest changed')
  const original=JSON.parse(files['/project/package.json']),manifest=readFileSync(join(fixture,'package.json'),'utf8')
  const expected={...original,dependencies:{...original.dependencies,...provenance.graphChanges.dependencies},overrides:provenance.graphChanges.overrides}
  if(JSON.stringify(JSON.parse(manifest))!==JSON.stringify(expected))throw Error('Portable graph differs from declared changes')
  files['/project/package.json']=manifest
  files['/project/package-lock.json']=readFileSync(join(fixture,'package-lock.json'),'utf8')
  files['/project/SDK-SOURCE-LICENSE.txt']=readFileSync(resolve(source,'../../../LICENSE'),'utf8')
  files['/project/sdk-acceptance-server.mjs']=`try {const {createServer}=await import('vite');const server=await createServer({server:{host:'127.0.0.1',strictPort:true}});await server.listen();console.log('SITE_START_READY')}catch(error){console.error(error?.stack??error);throw error}`
  return {files,hashes,provenance,lockfileSHA256:hash(files['/project/package-lock.json']),processEnv:provenance.env??{}}
}
export function confinedFile(root,path){const file=realpathSync(resolve(root,path));if(!file.startsWith(realpathSync(root)+sep))throw Error('Outside hosted directory');return file}
export function validateNativeFirefox(binary){
  const executable=realpathSync(binary),resources=resolve(dirname(executable),'../Resources')
  if(existsSync(join(resources,'playwright.cfg'))||existsSync(join(resources,'defaults/pref/00-playwright-prefs.js')))throw Error('Native acceptance requires stock Firefox, Playwright builds attach Juggler even without a protocol flag')
  return {executable,version:readFileSync(join(resources,'application.ini'),'utf8').match(/^Version=(.*)$/m)?.[1]}
}
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`))})
const close=server=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve())})
export async function startNativeStartHost({sdkRoot,fixture=prepareNativeStartFixture()}){
  sdkRoot=realpathSync(sdkRoot)
  const manifestBytes=readFileSync(join(sdkRoot,'manifest.json')),manifest=JSON.parse(manifestBytes)
  if(!manifest.experimentalRolldownParser||!manifest.engines?.['quickjs-als-asyncify-wasm-atomics-fibers-shared-storage'])throw Error('Packaged fiber/native-parser SDK required')
  const hosting=JSON.parse(readFileSync(join(sdkRoot,'preview-host/hosting.json'),'utf8'))
  const token=randomBytes(24).toString('hex'),violations=[],stages=[]
  let offline=false,cold,result,resolveResult
  const completed=new Promise(resolve=>resolveResult=resolve)
  const preview=createServer((request,response)=>{
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp');response.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    const route=hosting.routes.find(route=>route.path===new URL(request.url,'http://localhost').pathname&&route.method===request.method)
    if(!route){response.writeHead(hosting.fallbackStatus);response.end('No workspace attached');return}
    response.writeHead(200,route.headers);response.end(readFileSync(confinedFile(join(sdkRoot,'preview-host'),route.file)))
  })
  const previewOrigin=await listen(preview)
  const config={...fixture,token,previewOrigin,readinessScript:`(${observeNativeStartReadiness.toString()})();`,ownerPolicy:{maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024},experimentalCompiler:{maxMemoryPages:1024,timeoutMs:30000,lifetime:'session'},experimentalRolldownParser:{timeoutMs:30000,maxSourceBytes:16*1024*1024},experimentalFibers:true,workerMaxBytes:64*1024*1024,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true}}}
  let ownerOrigin
  const owner=createServer(async(request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Embedder-Policy','require-corp');response.setHeader('Cache-Control','no-store')
    if(offline)response.setHeader('Content-Security-Policy',`connect-src 'self' ${previewOrigin}; report-uri /__test/csp?token=${token}`)
    const url=new URL(request.url,'http://localhost')
    try{
      if(url.pathname.startsWith('/__test/')){
        if(request.method!=='POST'||url.searchParams.get('token')!==token){response.writeHead(403);response.end();return}
        // Cross-origin websites cannot send acceptance results to this receiver.
        if(request.headers.origin&&request.headers.origin!==ownerOrigin){response.writeHead(403);response.end();return}
        let size=0,chunks=[];for await(const chunk of request){size+=chunk.length;if(size>2*1024*1024)throw Error('Result body too large');chunks.push(chunk)}
        const value=JSON.parse(Buffer.concat(chunks).toString()||'{}')
        switch(url.pathname){
          case '/__test/stage':if(stages.length<64)stages.push(value);break
          case '/__test/cold':cold=value;break
          case '/__test/offline':if(!cold?.saved)throw Error('Cold snapshot must precede offline mode');offline=true;break
          case '/__test/csp':case '/__test/violation':if(violations.length<128)violations.push(value);break
          case '/__test/result':if(result)throw Error('Result already received');result=value;break
          default:response.writeHead(404);response.end();return
        }
        response.writeHead(200,{'Content-Type':'application/json'});response.end('{}')
        if(result)resolveResult(result)
        return
      }
      if(request.method!=='GET'){response.writeHead(405);response.end();return}
      if(url.pathname==='/app/'){
        response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><head><meta charset="utf-8"><title>Native Firefox Start acceptance</title></head><body><div id="preview"></div><script type="module" src="/driver.js"></script></body></html>');return
      }
      if(url.pathname==='/driver.js'){
        response.setHeader('Content-Type','text/javascript')
        response.end(`import * as sdk from '/app/vendor/index.js';const config=await(await fetch('/config.json')).json();await (${runNativeStart.toString()})({sdk,config,store:${startSnapshotStore.toString()},fingerprint:${fingerprintStartWorkspace.toString()},classify:${classifyNavigationCancellations.toString()}});`);return
      }
      if(url.pathname==='/config.json'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({...config,files:offline?{}:fixture.files}));return}
      if(!url.pathname.startsWith('/app/vendor/'))throw Error('Not a package path')
      const file=confinedFile(sdkRoot,decodeURIComponent(url.pathname.slice('/app/vendor/'.length)))
      response.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');response.end(readFileSync(file))
    }catch(error){response.writeHead(400,{'Content-Type':'text/plain'});response.end(String(error))}
  })
  try{ownerOrigin=await listen(owner)}catch(error){await close(preview);throw error}
  return {ownerOrigin,previewOrigin,token,completed,evidence:()=>({manifestSHA256:hash(manifestBytes),buildProfile:manifest.buildProfile,sourceHashes:fixture.hashes,lockfileSHA256:fixture.lockfileSHA256,provenance:fixture.provenance,stages,cold,result,violations,offline}),close:()=>Promise.all([close(owner),close(preview)])}
}

export async function runNativeFirefoxStart({sdkRoot,binary,output,source}){
  const {executable,version}=validateNativeFirefox(binary)
  const fixture=prepareNativeStartFixture(source),host=await startNativeStartHost({sdkRoot,fixture})
  const profile=mkdtempSync(join(tmpdir(),'native-firefox-start-'))
  const args=['-no-remote','-headless','-profile',profile,host.ownerOrigin+'/app/']
  let child,timer,stderr='',failure
  const started=Date.now()
  try{
    child=spawn(executable,args,{stdio:['ignore','ignore','pipe']})
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-8192)})
    await Promise.race([host.completed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native Start acceptance exceeded 120000ms')),120000);child.once('error',reject);child.once('exit',(code,signal)=>reject(Error(`Firefox exited before result: ${code}/${signal}`)))})])
    // Allow queued CSP reports to reach the receiver after the final browser fetch.
    await new Promise(resolve=>setTimeout(resolve,100))
  }catch(error){failure=String(error)+'\n'+String(error?.stack??'')}finally{
    clearTimeout(timer)
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve()},5000);child.once('exit',()=>{clearTimeout(timer);resolve()})})}
    await host.close()
  }
  const evidence=host.evidence()
  const passed=!failure&&evidence.result?.passed===true&&evidence.result.resumed===true&&evidence.offline&&evidence.violations.length===0
  const report={scope:'Actual Start counter, native Firefox without automation debugger; SDK programmatic DOM clicks',passed,failure,browser:{binary:executable,version,args,profile},elapsedMs:Date.now()-started,stderr,...evidence}
  writeFileSync(output,JSON.stringify(report,null,2)+'\n')
  return report
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(!process.env.SDK_OUTPUT||!process.env.FIREFOX_BINARY)throw Error('Set SDK_OUTPUT and FIREFOX_BINARY')
  const output=resolve(process.env.NATIVE_START_REPORT??'reports/native-firefox-start.json')
  const report=await runNativeFirefoxStart({sdkRoot:process.env.SDK_OUTPUT,binary:process.env.FIREFOX_BINARY,output,source:process.env.SDK_SITE_EXAMPLE})
  console.log(JSON.stringify({passed:report.passed,failure:report.failure,report:output,profile:report.browser.profile}))
  if(!report.passed)process.exitCode=1
}
