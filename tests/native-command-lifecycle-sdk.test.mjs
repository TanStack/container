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

// Ordinary command replacement, not a replacement for the full release gate.
test('installed Node commands finish, stop and start a replacement',{
  skip:process.env.NATIVE_COMMAND_LIFECYCLE_CONTROL!=='1'?'Opt-in installed command lifecycle control':false,
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
  const selected=['chromium','firefox','webkit'].filter(name=>!process.env.NATIVE_TEST_BROWSER||process.env.NATIVE_TEST_BROWSER===name)
  assert.ok(selected.length,'No requested browser matched')
  const identity=()=>nativeReleaseAcceptanceIdentity(process.cwd(),sdk,deployment),before=identity()
  const testSHA256=hash(readFileSync(new URL(import.meta.url)))
  const candidates=(await import(pathToFileURL(join(sdk,'assets.mjs')))).readNativeRuntimeCandidates()
  assert.equal(candidates.length,2,'Cover both shipped toolchains')
  console.log(JSON.stringify({kind:'command-lifecycle-inputs',identity:before,testSHA256,runnerLockSHA256:hash(runnerLock),selected}))
  const sdkAssets=sdkBrowserAssets(sdk)
  let hostOrigin,ownerOrigin,previewOrigin
  const host=createServer((request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    const url=new URL(request.url,'http://localhost'),asset=sdkAssets.get(url.pathname)
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
          await page.goto(hostOrigin+'/?runtime='+index)
          const result=await page.evaluate(async({ownerOrigin,previewOrigin})=>{
            await Promise.race([window.ownerReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owner did not become ready')),10000))])
            const {NativeOwnerClient,runNativeAgentCommand,spawnNativeAgentProcess}=await import('/sdk/index.js')
            const client=await NativeOwnerClient.connect(document.querySelector('#owner').contentWindow,ownerOrigin,previewOrigin)
            const phases=[],commands=[]
            // Buffer existing phase messages, no worker proxy or per-phase console logging.
            const unsubscribe=client.subscribeEvents(event=>{
              if(event.type==='progress')phases.push({phase:event.phase,elapsedMs:Math.round(performance.now())})
            })
            try{
              await client.start({
                '/app/package.json':'{"type":"module"}',
                '/app/index.html':'<!doctype html><script type="module" src="/main.js"></script>',
                '/app/main.js':'document.body.textContent="command lifecycle"',
                '/app/done.cjs':'process.stdout.write("done");',
                '/app/wait.cjs':'process.stdout.write("ready");setInterval(()=>{},1000);',
              },{installDependencies:false})
              for(const previous of ['natural','cancel','natural','cancel']){
                const started=performance.now()
                if(previous==='natural'){
                  const command=await runNativeAgentCommand(client,{command:'node',args:['done.cjs'],cwd:'/app'})
                  if(command.status!==0||command.stdout!=='done'||command.stderr)throw Error('Natural command failed: '+JSON.stringify(command))
                }else{
                  const command=spawnNativeAgentProcess(client,{command:'node',args:['wait.cjs'],cwd:'/app'})
                  try{
                    const ready=await command.next()
                    if(ready?.type!=='stdout'||new TextDecoder().decode(ready.bytes)!=='ready')throw Error('Stopped command did not reach ready')
                    if((await client.resources()).commands!==1)throw Error('Missing active command')
                    if(!await command.kill())throw Error('Stop was not acknowledged')
                    let error
                    try{await command.wait()}catch(failure){error=failure}
                    if(error?.name!=='AbortError')throw Error('Stopped command lost AbortError')
                  }finally{await command.dispose()}
                }
                if((await client.resources()).commands!==0)throw Error('Previous command stayed active')
                const replacementStarted=performance.now()
                const replacement=await runNativeAgentCommand(client,{command:'node',args:['done.cjs'],cwd:'/app'})
                if(replacement.status!==0||replacement.stdout!=='done'||replacement.stderr)throw Error('Replacement failed: '+JSON.stringify(replacement))
                const resources=await client.resources()
                if(resources.commands!==0)throw Error('Replacement stayed active')
                commands.push({previous,replacementStatus:replacement.status,commands:resources.commands,
                  previousMs:Math.round(replacementStarted-started),replacementMs:Math.round(performance.now()-replacementStarted)})
              }
              return {passed:true,commands,phases}
            }catch(error){return {passed:false,error:String(error),stack:error.stack,commands,phases}}
            finally{unsubscribe();await client.dispose();client.close()}
          },{ownerOrigin,previewOrigin})
          console.log(JSON.stringify({kind:'command-lifecycle-result',browser:name,version:browser.version(),toolchain:candidate.toolchain,...result,errors}))
          assert.equal(result.passed,true,result.error)
          assert.deepEqual(errors,[])
          assert.equal(result.commands.length,4)
          assert.deepEqual(identity(),before,'Installed input changed')
          assert.equal(hash(readFileSync(new URL(import.meta.url))),testSHA256,'Test source changed')
          assert.equal(hash(readFileSync(join(runnerRoot,'package-lock.json'))),hash(runnerLock),'Runner lock changed')
        }finally{await page.close()}
      }}finally{await browser.close()}
    }
  }finally{await Promise.all([host,owner,preview].map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))))}
})
