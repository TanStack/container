import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {join,resolve,sep,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {sdkBrowserAssets} from '../scripts/sdk-browser-assets.mjs'
import {nativeReleaseAcceptanceIdentity} from '../scripts/native-release-acceptance.mjs'
import {nativeWorkerPreloadFiles,nativeWorkerPreloadExpected,nativeWorkerPreloadFlags,nativeWorkerNestedPreloadExpected} from './fixtures/native-worker-preloads.mjs'
import {nativeWorkerDataParent,nativeWorkerDataExpected} from './fixtures/native-worker-data-url.mjs'

const binding=`!!globalThis[Symbol.for('web-container:rolldown-binding')]`
const snapshot=`process.stdout.write(JSON.stringify({compiler:${binding},answer:require('./answer.cjs')}))`
const parent=`const {Worker}=require('node:worker_threads');
const collect=options=>new Promise((resolve,reject)=>{
  const worker=new Worker(options.eval?${JSON.stringify(`const {parentPort}=require('node:worker_threads');parentPort.postMessage({compiler:${binding},answer:42});parentPort.close();`)}:options.entry,options);
  let message;worker.on('message',value=>message=value);worker.on('error',reject);
  worker.on('exit',code=>code?reject(Error('worker exit '+code)):resolve(message));
});(async()=>{const before=${binding};const results=[];
for(const options of [{eval:true},{entry:'./worker.cjs'},{entry:'./worker.mjs'},{entry:'./worker-dynamic.cjs'}])results.push(await collect(options));
console.log(JSON.stringify({before,results,after:${binding}}))})().catch(error=>{console.error(error);process.exitCode=1});`
const files={
  '/app/package.json':'{"type":"module"}',
  '/app/index.html':'<!doctype html><script type="module" src="/main.js"></script>',
  '/app/main.js':'document.body.textContent="bootstrap control"',
  '/app/answer.cjs':'module.exports=42;',
  '/app/plain.cjs':snapshot+';module.exports=null;',
  '/app/plain.js':'process.stdout.write("module-js");export const answer=42;',
  '/app/legacy/package.json':'{"type":"commonjs"}',
  '/app/legacy/plain.js':snapshot.replace("'./answer.cjs'","'../answer.cjs'"),
  '/app/legacy/bin':'#!/usr/bin/env node\n'+snapshot.replace("'./answer.cjs'","'../answer.cjs'"),
  '/app/bin':`#!/usr/bin/env node\nimport {answer} from './answer.mjs';process.stdout.write('module-bin:'+answer);`,
  '/app/answer.mjs':'export const answer=42;',
  '/app/module.mjs':`import {answer} from './answer.mjs';await new Promise(resolve=>setTimeout(resolve,5));console.log(JSON.stringify({compiler:${binding},answer}));`,
  '/app/dynamic.cjs':`const before=${binding};module.exports.__promise=import('./answer.mjs').then(({answer})=>console.log(JSON.stringify({before,compiler:${binding},answer})));`,
  '/app/timer.cjs':`setTimeout(()=>process.stdout.write('timer'),5);`,
  '/app/failure.cjs':`throw Error('bootstrap guest failure');`,
  '/app/worker.cjs':`const {parentPort}=require('node:worker_threads');parentPort.postMessage({compiler:${binding},answer:42});parentPort.close();`,
  '/app/worker.mjs':`import {parentPort} from 'node:worker_threads';await Promise.resolve();parentPort.postMessage({compiler:${binding},answer:42});parentPort.close();`,
  '/app/worker-dynamic.cjs':`const {parentPort}=require('node:worker_threads');const before=${binding};import('./answer.mjs').then(({answer})=>{parentPort.postMessage({before,compiler:${binding},answer});parentPort.close()});`,
  '/app/workers.cjs':parent,
  ...nativeWorkerPreloadFiles,
}
const cases=[
  {name:'eval',args:['-e',snapshot],json:{compiler:false,answer:42}},
  {name:'stdin',args:['-'],stdin:snapshot,json:{compiler:false,answer:42}},
  ...['plain.cjs','legacy/plain.js','legacy/bin'].map(file=>({name:file,args:[file],json:{compiler:false,answer:42}})),
  {name:'package-module-bin',args:['bin'],stdout:'module-bin:42'},
  {name:'package-module-js',args:['plain.js'],stdout:'module-js'},
  {name:'module',args:['module.mjs'],json:{compiler:true,answer:42}},
  {name:'module-eval',args:['--input-type=module','-e',`import {answer} from './answer.mjs';console.log(JSON.stringify({compiler:${binding},answer}))`],json:{compiler:true,answer:42}},
  {name:'dynamic',args:['dynamic.cjs'],json:{before:false,compiler:true,answer:42}},
  {name:'timer',args:['timer.cjs'],stdout:'timer'},
  {name:'failure',args:['failure.cjs'],status:1,error:'bootstrap guest failure'},
  {name:'worker-formats',args:['workers.cjs'],json:{before:false,results:[{compiler:false,answer:42},{compiler:false,answer:42},{compiler:true,answer:42},{before:false,compiler:true,answer:42}],after:false}},
  {name:'worker-preloads',args:['preload-parent.cjs'],json:nativeWorkerPreloadExpected},
  {name:'worker-inherited-preloads',args:[...nativeWorkerPreloadFlags,'preload-inherited-parent.cjs'],json:nativeWorkerPreloadExpected},
  {name:'worker-nested-preloads',args:[...nativeWorkerPreloadFlags,'preload-nested-parent.cjs'],json:nativeWorkerNestedPreloadExpected},
  {name:'worker-data-url',args:['-e',nativeWorkerDataParent],json:nativeWorkerDataExpected},
]

test('bootstrap command fixtures preserve real Node module and worker behavior',()=>{
  const directory=mkdtempSync(join(tmpdir(),'container-bootstrap-node-'))
  for(const [path,source]of Object.entries(files)){
    const target=join(directory,path.slice('/app/'.length))
    mkdirSync(dirname(target),{recursive:true});writeFileSync(target,source,{flag:'wx'})
  }
  const withoutBrowserCompiler=value=>Array.isArray(value)?value.map(withoutBrowserCompiler):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='compiler'?false:withoutBrowserCompiler(item)])):value
  for(const entry of cases){
    const result=spawnSync(process.execPath,entry.args,{cwd:directory,input:entry.stdin,encoding:'utf8',timeout:10000})
    assert.equal(result.error,undefined,entry.name);assert.equal(result.status,entry.status??0,entry.name+': '+result.stderr)
    if(entry.error)assert.ok(result.stderr.includes(entry.error))
    else assert.equal(result.stderr,'',entry.name)
    if(entry.json)assert.deepEqual(JSON.parse(result.stdout),withoutBrowserCompiler(entry.json),entry.name)
    if(entry.stdout!==undefined)assert.equal(result.stdout,entry.stdout,entry.name)
  }
})

// Each engine has its own bounded test, like the full desktop example gate.
const selectedBootstrapBrowsers=['chromium','firefox','webkit'].filter(name=>!process.env.NATIVE_TEST_BROWSER||name===process.env.NATIVE_TEST_BROWSER)
let bootstrapInputs
if(process.env.NATIVE_COMMAND_BOOTSTRAP_CONTROL==='1')assert.ok(selectedBootstrapBrowsers.length,'No requested bootstrap browser matched')
for(const targetBrowser of ['chromium','firefox','webkit'])test('installed Node command bootstrap in '+targetBrowser,{
  skip:process.env.NATIVE_COMMAND_BOOTSTRAP_CONTROL!=='1'||!selectedBootstrapBrowsers.includes(targetBrowser)?'Opt-in installed bootstrap control':false,timeout:180000,
},async()=>{
  const root=process.cwd(),sdk=resolve(process.env.NATIVE_SDK_BUNDLE_DIR),deployment=resolve(process.env.NATIVE_DEPLOYMENT_DIR)
  const require=createRequire(join(root,'package.json')),lock=readFileSync(join(root,'package-lock.json'))
  for(const name of ['@playwright/test','playwright','playwright-core'])assert.equal(require(name+'/package.json').version,JSON.parse(lock).packages['node_modules/'+name].version)
  const browsers=require('@playwright/test'),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
  const identity=()=>nativeReleaseAcceptanceIdentity(root,sdk,deployment),before=identity()
  const testSHA256=hash(readFileSync(new URL(import.meta.url)))
  const inputs={kind:'command-bootstrap-inputs',identity:before,testSHA256,runnerLockSHA256:hash(lock),selected:selectedBootstrapBrowsers}
  if(bootstrapInputs)assert.deepEqual(inputs,bootstrapInputs,'Bootstrap inputs changed between browser tests')
  else bootstrapInputs=inputs
  const candidates=(await import(pathToFileURL(join(sdk,'assets.mjs')))).readNativeRuntimeCandidates()
  assert.equal(candidates.length,2)
  const sdkAssets=sdkBrowserAssets(sdk)
  let hostOrigin,ownerOrigin,previewOrigin
  const host=createServer((request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    const url=new URL(request.url,'http://localhost'),asset=sdkAssets.get(url.pathname)
    if(asset){response.setHeader('Content-Type','text/javascript');response.end(readFileSync(asset));return}
    response.setHeader('Content-Type','text/html')
    response.end(`<!doctype html><script>window.ownerReady=new Promise(resolve=>addEventListener('message',event=>{if(event.origin===${JSON.stringify(ownerOrigin)}&&event.data==='ready')resolve()}));</script><iframe id="owner" allow="cross-origin-isolated" src="${ownerOrigin}/owner.html?runtime=${Number(url.searchParams.get('runtime'))}"></iframe>`)
  })
  const owner=createServer(async(request,response)=>{
    const url=new URL(request.url,'http://localhost'),path=url.pathname
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp');response.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    if(path==='/owner.html'){
      const candidate=candidates[Number(url.searchParams.get('runtime'))]
      if(!candidate){response.writeHead(400);response.end();return}
      response.setHeader('Content-Type','text/html')
      response.end(`<!doctype html><script type="module">import {installNativeOwnerHost} from '/sdk/index.js';installNativeOwnerHost({allowedParentOrigin:${JSON.stringify(hostOrigin)},workerURL:${JSON.stringify(candidate.workerURL)},previewOrigin:${JSON.stringify(previewOrigin)}});parent.postMessage('ready',${JSON.stringify(hostOrigin)});</script>`)
      return
    }
    const runtimeRoot=resolve(deployment,'runtime'),candidate=/^\/runtime\/(?:native|workers|mvdan-shell)\/[A-Za-z0-9._/-]+$/.test(path)?resolve(deployment,path.slice(1)):undefined
    const asset=sdkAssets.get(path)??(candidate?.startsWith(runtimeRoot+sep)?candidate:undefined)
    if(!asset){response.writeHead(404);response.end();return}
    try{response.setHeader('Content-Type',path.endsWith('.wasm')?'application/wasm':'text/javascript');response.end(await readFile(asset))}
    catch(error){response.writeHead(500);response.end(String(error))}
  })
  const preview=createServer((request,response)=>{response.writeHead(503);response.end('No preview attached')})
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)))
  try{
    hostOrigin=await listen(host);ownerOrigin=await listen(owner);previewOrigin=await listen(preview)
    if(targetBrowser===selectedBootstrapBrowsers[0])console.log(JSON.stringify(inputs))
    for(const name of [targetBrowser]){
      const browser=await browsers[name].launch()
      try{for(const [index,candidate] of candidates.entries()){
        const page=await browser.newPage(),errors=[]
        page.on('pageerror',error=>errors.push(String(error)))
        try{
          await page.goto(hostOrigin+'/?runtime='+index)
          const result=await page.evaluate(async({ownerOrigin,previewOrigin,files,cases})=>{
            await window.ownerReady
            const {NativeOwnerClient,runNativeAgentCommand}=await import('/sdk/index.js')
            const client=await NativeOwnerClient.connect(document.querySelector('#owner').contentWindow,ownerOrigin,previewOrigin),commands=[]
            try{
              await client.start(files,{installDependencies:false})
              for(const entry of cases){
                const started=performance.now()
                const command=await runNativeAgentCommand(client,{command:'node',args:entry.args,cwd:'/app'},entry.stdin===undefined?{}:{onInput:input=>{input.writeInput(entry.stdin);input.endInput()}})
                const resources=await client.resources()
                commands.push({name:entry.name,...command,commands:resources.commands,elapsedMs:Math.round(performance.now()-started)})
              }
              return {passed:true,commands}
            }catch(error){return {passed:false,error:String(error),commands}}
            finally{await client.dispose();client.close()}
          },{ownerOrigin,previewOrigin,files,cases})
          console.log(JSON.stringify({kind:'command-bootstrap-result',browser:name,version:browser.version(),toolchain:candidate.toolchain,...result,errors}))
          assert.equal(result.passed,true,result.error);assert.deepEqual(errors,[]);assert.equal(result.commands.length,cases.length)
          for(const [index,command]of result.commands.entries()){
            const expected=cases[index]
            assert.equal(command.name,expected.name);assert.equal(command.status,expected.status??0,command.stderr)
            assert.equal(command.commands,0);assert.equal(command.truncated,false)
            if(expected.error)assert.ok(command.stderr.includes(expected.error))
            else assert.equal(command.stderr,'')
            if(expected.json)assert.deepEqual(JSON.parse(command.stdout),expected.json,expected.name)
            if(expected.stdout!==undefined)assert.equal(command.stdout,expected.stdout)
          }
          assert.deepEqual(identity(),before);assert.equal(hash(readFileSync(new URL(import.meta.url))),testSHA256)
          assert.equal(hash(readFileSync(join(root,'package-lock.json'))),hash(lock))
        }finally{await page.close()}
      }}finally{await browser.close()}
    }
  }finally{await Promise.all([host,owner,preview].map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))))}
})
