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

test('installed native workers run the Node directory workload and preserve callback context',{
  skip:process.env.NATIVE_OWNER_DIRECTORY_CONTROL!=='1'?'Opt-in installed directory control':false,timeout:180000,
},async()=>{
  const sdk=resolve(process.env.NATIVE_SDK_BUNDLE_DIR),deployment=resolve(process.env.NATIVE_DEPLOYMENT_DIR)
  const runnerRoot=resolve(process.env.NATIVE_DIRECTORY_PLAYWRIGHT_ROOT??process.cwd())
  const runner=createRequire(join(runnerRoot,'package.json'))
  const runnerLock=readFileSync(join(runnerRoot,'package-lock.json'))
  const lockedPackages=JSON.parse(runnerLock).packages
  for(const name of ['@playwright/test','playwright','playwright-core']){
    const version=lockedPackages?.['node_modules/'+name]?.version
    assert.match(version??'',/^\d+\.\d+\.\d+$/,'Browser runner requires a locked version: '+name)
    assert.equal(runner(name+'/package.json').version,version,'Installed browser runner differs from its lock: '+name)
  }
  const {chromium,firefox,webkit}=runner('@playwright/test')
  const identity=()=>nativeReleaseAcceptanceIdentity(process.cwd(),sdk,deployment),before=identity()
  const candidates=(await import(pathToFileURL(join(sdk,'assets.mjs')))).readNativeRuntimeCandidates()
  assert.equal(candidates.length,2,'Both shipped compiler variants must be covered')
  const sdkAssets=sdkBrowserAssets(sdk)
  const workload=readFileSync(new URL('./fixtures/native-filesystem-directory-workload.mjs',import.meta.url),'utf8')
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
  const sourceIdentity={testSHA256:hash(readFileSync(new URL(import.meta.url))),workloadSHA256:hash(workload),runnerLockSHA256:hash(runnerLock)}
  console.log(JSON.stringify({kind:'installed-directory-control-inputs',sdk,deployment,...sourceIdentity,identity:before}))
  const script=`import fs,{opendirSync,opendir,Dir,Dirent} from 'node:fs';
    import {opendir as promiseOpen} from 'node:fs/promises';import {AsyncLocalStorage} from 'node:async_hooks';
    ${workload}
    const result=await runDirectoryControl(fs,'/app/directory-work');
    const named=opendirSync('/app/directory-work');
    if(!(named instanceof Dir)||!(named.readSync() instanceof Dirent))throw Error('Named directory exports failed');
    named.closeSync();
    const callback=await new Promise((resolve,reject)=>opendir('/app/directory-work',(error,value)=>error?reject(error):resolve(value)));
    callback.closeSync();const promised=await promiseOpen('/app/directory-work');await promised.close();
    const store=new AsyncLocalStorage(),directory=fs.opendirSync('/app/directory-work',{bufferSize:1});
    const read=store.run('read-context',()=>new Promise((resolve,reject)=>directory.read((error,entry)=>{
      if(store.getStore()!=='read-context')return reject(Error('Directory read lost async context'));
      error?reject(error):resolve(entry);
    })));
    const close=store.run('close-context',()=>new Promise((resolve,reject)=>directory.close(error=>{
      if(store.getStore()!=='close-context')return reject(Error('Directory close lost async context'));
      error?reject(error):resolve();
    })));
    await Promise.all([read,close]);
    console.log('DIRECTORY_SDK_RESULT '+JSON.stringify({...result,callbackContext:true,namedExports:true}));
  `
  let hostOrigin,ownerOrigin,previewOrigin
  const host=createServer((request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    const asset=sdkAssets.get(new URL(request.url,'http://localhost').pathname)
    if(asset){response.setHeader('Content-Type','text/javascript');response.end(readFileSync(asset));return}
    const index=Number(new URL(request.url,'http://localhost').searchParams.get('runtime'))
    response.setHeader('Content-Type','text/html')
    response.end(`<!doctype html><script>
      window.ownerReady=new Promise(resolve=>addEventListener('message',event=>{
        if(event.origin===${JSON.stringify(ownerOrigin)}&&event.data==='ready')resolve();
      }));
      </script><iframe id="owner" allow="cross-origin-isolated" src="${ownerOrigin}/owner.html?runtime=${index}"></iframe>`)
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
        installNativeOwnerHost({allowedParentOrigin:${JSON.stringify(hostOrigin)},
          workerURL:${JSON.stringify(candidate.workerURL)},previewOrigin:${JSON.stringify(previewOrigin)}});
        parent.postMessage('ready',${JSON.stringify(hostOrigin)});
      </script>`)
      return
    }
    const runtimeRoot=resolve(deployment,'runtime')
    const candidate=/^\/runtime\/(?:native|workers|mvdan-shell)\/[A-Za-z0-9._/-]+$/.test(path)
      ?resolve(deployment,path.slice(1)):undefined
    const asset=sdkAssets.get(path)??(candidate?.startsWith(runtimeRoot+sep)?candidate:undefined)
    if(!asset){response.writeHead(404);response.end();return}
    try{
      response.setHeader('Content-Type',path.endsWith('.wasm')?'application/wasm':'text/javascript')
      response.end(await readFile(asset))
    }catch(error){response.writeHead(500);response.end(String(error))}
  })
  const preview=createServer((request,response)=>{response.writeHead(503);response.end('No preview attached')})
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)))
  try{
    hostOrigin=await listen(host);ownerOrigin=await listen(owner);previewOrigin=await listen(preview)
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch()
      try{for(const [index,candidate] of candidates.entries()){
        const page=await browser.newPage(),errors=[]
        page.on('pageerror',error=>errors.push(String(error)))
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
        await page.goto(hostOrigin+'/?runtime='+index)
        const result=await page.evaluate(async({ownerOrigin,previewOrigin,script})=>{
          await Promise.race([window.ownerReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owner did not become ready')),10000))])
          const {NativeOwnerClient,runNativeAgentCommand}=await import('/sdk/index.js')
          const client=await NativeOwnerClient.connect(document.querySelector('#owner').contentWindow,ownerOrigin,previewOrigin)
          try{
            await client.start({
              '/app/package.json':'{"type":"module"}',
              '/app/index.html':'<!doctype html><script type="module" src="/main.js"></script>',
              '/app/main.js':'document.body.textContent="directory control"',
              '/app/directories.mjs':script,
            },{installDependencies:false})
            const command=await runNativeAgentCommand(client,{command:'node',args:['directories.mjs'],cwd:'/app'})
            const resources=await client.resources()
            return {command,resources}
          }finally{await client.dispose();client.close()}
        },{ownerOrigin,previewOrigin,script})
        assert.equal(result.command.status,0,result.command.stderr)
        const lines=result.command.stdout.split('\n').filter(line=>line.startsWith('DIRECTORY_SDK_RESULT '))
        assert.equal(lines.length,1,result.command.stdout)
        const directory=JSON.parse(lines[0].slice('DIRECTORY_SDK_RESULT '.length))
        assert.equal(directory.passed,true);assert.equal(directory.callbackContext,true)
        assert.equal(directory.namedExports,true)
        assert.equal(directory.checks.length,26)
        assert.equal(result.resources.commands,0)
        assert.deepEqual(errors,[])
        assert.deepEqual(identity(),before,'Installed inputs changed during directory control')
        assert.equal(hash(readFileSync(new URL(import.meta.url))),sourceIdentity.testSHA256,'Directory control source changed')
        assert.equal(hash(readFileSync(new URL('./fixtures/native-filesystem-directory-workload.mjs',import.meta.url))),sourceIdentity.workloadSHA256,'Directory workload changed')
        assert.equal(hash(readFileSync(join(runnerRoot,'package-lock.json'))),sourceIdentity.runnerLockSHA256,'Browser runner lock changed')
        console.log(JSON.stringify({browser:engine.name(),version:browser.version(),toolchain:candidate.toolchain,
          ...directory,commands:result.resources.commands,errors,passed:true}))
        await page.close()
      }}finally{await browser.close()}
    }
  }finally{await Promise.all([host,owner,preview].map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))))}
})
