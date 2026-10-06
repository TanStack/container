import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {join,resolve,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import {sdkBrowserAssets} from '../scripts/sdk-browser-assets.mjs'
import {nativeReleaseAcceptanceIdentity} from '../scripts/native-release-acceptance.mjs'

import {checkNativeOwnerSoak,nativeOwnerSoakCycles} from '../scripts/native-owner-soak.mjs'

if(process.env.NATIVE_OWNER_SOAK==='1'&&process.env.NATIVE_TEST_BROWSER)
  assert.ok(['chromium','firefox','webkit'].includes(process.env.NATIVE_TEST_BROWSER),'Unknown soak browser')

// A bounded same-document lifecycle check, not full application or release acceptance.
for(const targetBrowser of ['chromium','firefox','webkit'])test('same owner survives ten project and terminal cycles in '+targetBrowser,{
  skip:process.env.NATIVE_OWNER_SOAK!=='1'||process.env.NATIVE_TEST_BROWSER&&process.env.NATIVE_TEST_BROWSER!==targetBrowser?'Opt-in installed owner soak':false,
  timeout:180000,
},async()=>{
  const sdk=resolve(process.env.NATIVE_SDK_BUNDLE_DIR),deployment=resolve(process.env.NATIVE_DEPLOYMENT_DIR)
  const runnerRoot=resolve(process.env.NATIVE_COMMAND_PLAYWRIGHT_ROOT??process.cwd())
  const runner=createRequire(join(runnerRoot,'package.json'))
  const hash=value=>createHash('sha256').update(value).digest('hex')
  const runnerLock=readFileSync(join(runnerRoot,'package-lock.json'))
  for(const name of ['@playwright/test','playwright','playwright-core']){
    const version=JSON.parse(runnerLock).packages?.['node_modules/'+name]?.version
    assert.match(version??'',/^\d+\.\d+\.\d+$/,'Browser runner requires a locked version: '+name)
    assert.equal(runner(name+'/package.json').version,version)
  }
  const browsers=runner('@playwright/test')
  const selected=[targetBrowser]
  assert.ok(selected.length,'No requested browser matched')
  const identity=()=>nativeReleaseAcceptanceIdentity(process.cwd(),sdk,deployment),before=identity()
  const testSHA256=hash(readFileSync(new URL(import.meta.url)))
  const workloadPath=new URL('../scripts/native-owner-soak.mjs',import.meta.url)
  const workloadSHA256=hash(readFileSync(workloadPath))
  const candidates=(await import(pathToFileURL(join(sdk,'assets.mjs')))).readNativeRuntimeCandidates()
  assert.equal(candidates.length,2,'Cover both shipped toolchains')
  console.log(JSON.stringify({kind:'owner-soak-inputs',identity:before,testSHA256,workloadSHA256,cycles:nativeOwnerSoakCycles,runnerLockSHA256:hash(runnerLock),selected}))
  const sdkAssets=sdkBrowserAssets(sdk)
  let hostOrigin,ownerOrigin,previewOrigin
  const host=createServer((request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    const url=new URL(request.url,'http://localhost'),asset=sdkAssets.get(url.pathname)
    if(url.pathname==='/owner-soak.js'){response.setHeader('Content-Type','text/javascript');response.end(readFileSync(workloadPath));return}
    if(asset){response.setHeader('Content-Type','text/javascript');response.end(readFileSync(asset));return}
    response.setHeader('Content-Type','text/html')
    response.end(`<!doctype html><script>
      window.ownerReady=new Promise(resolve=>addEventListener('message',event=>{
        if(event.origin===${JSON.stringify(ownerOrigin)}&&event.data==='ready')resolve();
      }));</script><iframe id="owner" allow="cross-origin-isolated" src="${ownerOrigin}/owner.html?runtime=${Number(url.searchParams.get('runtime'))}"></iframe>`)
  })
  const owner=createServer(async(request,response)=>{
    const url=new URL(request.url,'http://localhost'),path=url.pathname
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    response.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    if(path==='/owner.html'){
      const candidate=candidates[Number(url.searchParams.get('runtime'))]
      if(!candidate){response.writeHead(400);response.end();return}
      response.setHeader('Content-Type','text/html')
      response.end(`<!doctype html><script type="module">
        import {installNativeOwnerHost} from '/sdk/index.js';
        installNativeOwnerHost({allowedParentOrigin:${JSON.stringify(hostOrigin)},workerURL:${JSON.stringify(candidate.workerURL)},previewOrigin:${JSON.stringify(previewOrigin)}});
        parent.postMessage('ready',${JSON.stringify(hostOrigin)});
      </script>`)
      return
    }
    const root=resolve(deployment,'runtime')
    const candidate=/^\/runtime\/(?:native|workers|mvdan-shell)\/[A-Za-z0-9._/-]+$/.test(path)?resolve(deployment,path.slice(1)):undefined
    const asset=sdkAssets.get(path)??(candidate?.startsWith(root+sep)?candidate:undefined)
    if(!asset){response.writeHead(404);response.end();return}
    try{response.setHeader('Content-Type',path.endsWith('.wasm')?'application/wasm':'text/javascript');response.end(await readFile(asset))}
    catch(error){response.writeHead(500);response.end(String(error))}
  })
  const preview=createServer((request,response)=>{response.writeHead(503);response.end('No preview attached')})
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)))
  try{
    hostOrigin=await listen(host);ownerOrigin=await listen(owner);previewOrigin=await listen(preview)
    for(const name of selected){
      const browser=await browsers[name].launch()
      try{for(const [index,candidate] of candidates.entries()){
        const page=await browser.newPage(),errors=[]
        page.on('pageerror',error=>errors.push(String(error)))
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
        try{
          await page.exposeFunction('recordSoakCycle',row=>console.log(JSON.stringify({kind:'owner-soak-cycle',browser:name,toolchain:candidate.toolchain,...row})))
          await page.goto(hostOrigin+'/?runtime='+index)
          const result=await page.evaluate(async({ownerOrigin,previewOrigin})=>{
            await Promise.race([window.ownerReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owner did not become ready')),10000))])
            const {NativeOwnerClient}=await import('/sdk/index.js')
            const client=await NativeOwnerClient.connect(document.querySelector('#owner').contentWindow,ownerOrigin,previewOrigin)
            const {runNativeOwnerSoak}=await import('/owner-soak.js')
            const diagnostics=[]
            const unsubscribe=client.subscribeEvents(event=>{
              if(event.type==='diagnostic')diagnostics.push(event)
            })
            const frame=document.querySelector('#owner'),documentToken={}
            window.soakDocumentToken=documentToken
            try{
              const cycles=await runNativeOwnerSoak(client,window.recordSoakCycle)
              if(document.querySelector('#owner')!==frame||window.soakDocumentToken!==documentToken)
                throw Error('Soak owner or document was replaced')
              return {passed:true,cycles,diagnostics}
            }catch(error){return {passed:false,error:String(error),stack:error.stack,cycles:error.rows??[],diagnostics}}
            finally{unsubscribe();await client.dispose();client.close()}
          },{ownerOrigin,previewOrigin})
          console.log(JSON.stringify({kind:'owner-soak-result',browser:name,version:browser.version(),toolchain:candidate.toolchain,...result,errors}))
          assert.equal(result.passed,true,result.error)
          assert.deepEqual(errors,[])
          checkNativeOwnerSoak(result.cycles,errors)
          assert.deepEqual(result.diagnostics,[])
          assert.deepEqual(identity(),before,'Installed input changed')
          assert.equal(hash(readFileSync(new URL(import.meta.url))),testSHA256,'Test source changed')
          assert.equal(hash(readFileSync(workloadPath)),workloadSHA256,'Soak workload changed')
          assert.equal(hash(readFileSync(join(runnerRoot,'package-lock.json'))),hash(runnerLock),'Runner lock changed')
        }finally{await page.close()}
      }}finally{await browser.close()}
    }
  }finally{await Promise.all([host,owner,preview].map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))))}
})
