import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,dirname,posix} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {transformSync,types as t} from '@babel/core'

test('actual native Oxide scans a live service-owned filesystem while its caller blocks',{
  skip:process.env.NATIVE_OXIDE_SERVICE_CONTROL!=='1'?'Opt-in actual native scanner service control':false,
  timeout:180000,
},async()=>{
  const root=resolve('.'),deployment=resolve(process.env.NATIVE_DEPLOYMENT_DIR)
  const pool=Number(process.env.NATIVE_OXIDE_SERVICE_POOL??1)
  assert.ok(Number.isInteger(pool)&&pool>=1&&pool<=8,'Invalid native scanner worker budget')
  const require=createRequire(join(resolve(process.env.NATIVE_COMPILER_FS_PLAYWRIGHT_ROOT),'package.json'))
  assert.equal(require('@playwright/test/package.json').version,'1.63.0')
  const engines=require('@playwright/test')
  const manifest=JSON.parse(readFileSync(join(deployment,'deployment-manifest.json')))
  const oxide=manifest.files.find(file=>file.path.startsWith('runtime/native/vite-8.3.1-')&&file.path.endsWith('/oxide/oxide.mjs'))
  assert.ok(oxide,'Missing installed shared-filesystem Oxide control binding')
  const prefix='/'+posix.dirname(oxide.path)
  const files=new Map(manifest.files.map(file=>['/'+file.path,file]))
  const receiptDirectory=mkdtempSync(join(tmpdir(),'native-oxide-service-'))
  const receipt={deployment,pool,manifestSHA256:createHash('sha256').update(readFileSync(join(deployment,'deployment-manifest.json'))).digest('hex'),
    scope:'Isolated installed native scanner transport experiment, not shipped SDK integration.',rows:[],passed:false}
  const save=()=>writeFileSync(join(receiptDirectory,'results.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log('Native Oxide service receipt: '+join(receiptDirectory,'results.json'));save()
  const failures=[]
  const original=path=>{
    const file=files.get(path);assert.ok(file,'Missing installed input: '+path)
    const bytes=readFileSync(join(deployment,file.path))
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256)
    return bytes
  }
  const binding=original('/'+oxide.path).toString()
  const chunkName=binding.match(/from "(\.\/chunk-[^"]+\.mjs)";/)?.[1]
  assert.ok(chunkName,'Pinned Oxide chunk layout changed')
  const chunk=prefix+chunkName.slice(1)
  const routes=new Map()
  if(process.env.NATIVE_OXIDE_SERVICE_WASM){
    const path=resolve(process.env.NATIVE_OXIDE_SERVICE_WASM),expected=process.env.NATIVE_OXIDE_SERVICE_WASM_SHA256
    assert.match(expected??'',/^[a-f0-9]{64}$/,'An experimental native binary needs an explicit SHA-256')
    const bytes=readFileSync(path),sha256=createHash('sha256').update(bytes).digest('hex')
    assert.equal(sha256,expected,'Experimental native binary changed')
    assert.ok(WebAssembly.validate(bytes),'Experimental scanner is not valid WASM')
    const url=prefix+'/tailwindcss-oxide.wasm32-wasi.wasm'
    const shipped=original(url)
    receipt.nativeBinary={path,sha256,shippedSHA256:createHash('sha256').update(shipped).digest('hex')}
    routes.set(url,bytes);save()
  }
  // The default control changes only transport endpoints. An explicit hashed
  // candidate binary can test a source-level fix with the same retained gate.
  let replacements=0,spawnMarkers=0
  const patched=transformSync(original(chunk).toString(),{babelrc:false,configFile:false,sourceType:'module',
    plugins:[()=>({visitor:{FunctionDeclaration(path){
      if(path.node.id?.name!=='createWasiFilesystemClient')return
      replacements++
      path.node.params=[t.restElement(t.identifier('args'))]
      path.node.body=t.blockStatement([t.returnStatement(t.callExpression(t.identifier('serviceFilesystemClient'),
        [t.spreadElement(t.identifier('args'))]))])
    },VariableDeclarator(path){
      if(path.node.id?.name!=='threadSpawn'||!t.isFunctionExpression(path.node.init))return
      spawnMarkers++
      path.node.init.body.body.unshift(t.expressionStatement(t.assignmentExpression('=',
        t.memberExpression(t.identifier('globalThis'),t.identifier('__oxideSpawnCount')),
        t.binaryExpression('+',t.logicalExpression('||',t.memberExpression(t.identifier('globalThis'),t.identifier('__oxideSpawnCount')),t.numericLiteral(0)),t.numericLiteral(1)))))
    }}})]}).code
  assert.equal(replacements,1,'Pinned transport factory changed')
  assert.equal(spawnMarkers,1,'Pinned native thread-spawn diagnostic anchor changed')
  routes.set(chunk,'import {createWasiFilesystemClient as serviceFilesystemClient} from "/transport.mjs";\n'+patched)
  const anchor='manageWasiFilesystemWorker(worker, createOnMessage(__fs));'
  assert.equal(binding.split(anchor).length,2,'Pinned compiler worker ownership changed')
  assert.ok(binding.includes('getCompilerFilesystem()'),'Use the retained shared-filesystem failure candidate')
  const budget='reuseWorker: { size: 1, strict: true }'
  assert.equal(binding.split(budget).length,2,'Pinned native worker budget changed')
  routes.set('/'+oxide.path,'import {attachCompilerWorker} from "/provider.mjs";\n'+binding.replace(anchor,'attachCompilerWorker(worker);')
    .replace(budget,`reuseWorker: { size: ${pool}, strict: true }`))
  const workerPath=prefix+'/wasi-worker-browser.mjs'
  const child=original(workerPath).toString(),dispatch='handler.handle(e);'
  assert.equal(child.split(dispatch).length,2,'Pinned worker dispatch changed')
  routes.set(workerPath,'import {connectWasiFilesystemPort} from "/transport.mjs";\n'+child.replace(dispatch,
    'if(e.data?.type==="filesystem-port")connectWasiFilesystemPort(e.data.port);else handler.handle(e);'))
  routes.set('/transport.mjs',readFileSync(join(root,'src/native/wasi-fs-transport.mjs'),'utf8'))
  routes.set('/filesystem-service.mjs',readFileSync(join(root,'src/native/wasi-filesystem-service.mjs'),'utf8'))
  routes.set('/filesystem-watch-protocol.mjs',readFileSync(join(root,'src/native/filesystem-watch-protocol.mjs'),'utf8'))
  const backend=await build({stdin:{contents:`import {createNativeFilesystemBackend} from './src/native/filesystem-backend.mjs';
    export const {fs,vol}=createNativeFilesystemBackend();`,resolveDir:root,sourcefile:'service-backend.mjs'},
    bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',
    alias:{'node:buffer':'buffer/','node:events':'events/','node:stream':'stream-browserify','node:path':'path-browserify'}})
  routes.set('/backend.mjs',backend.outputFiles[0].text)
  routes.set('/service.mjs',`import {fs,vol} from '/backend.mjs';
    import {createOnMessage} from ${JSON.stringify(chunk)};
    import {createWasiFilesystemService} from '/filesystem-service.mjs';
    const service=createWasiFilesystemService(fs,createOnMessage);
    self.onmessage=event=>{
      if(event.data.type==='control-port'){
        const port=event.data.port;port.onmessage=service.onMessage;port.start();
      }else if(event.data.type==='inspect')postMessage({stage:'service-state',...service.inspect()});
      else if(event.data.type==='dispose'){service.dispose();postMessage({stage:'service-disposed',...service.inspect()})}
    };
    postMessage({stage:'service-ready'});`)
  routes.set('/provider.mjs',`import {createFsProxy,memfsExported} from ${JSON.stringify(chunk)};
    import {connectWasiFilesystemPort,manageWasiFilesystemWorker} from '/transport.mjs';
    import {createWasiFilesystemEndpoint} from '/filesystem-service.mjs';
    let control,next=0;
    export const endpoints=[];
    export function configure(port){
      control=port;const endpoint=createWasiFilesystemEndpoint(control,'main');endpoints.push(endpoint);
      connectWasiFilesystemPort(endpoint.port);
      const fs=createFsProxy(memfsExported);
      Object.defineProperty(globalThis,Symbol.for('tanstack-container:compiler-filesystem-v1'),{value:{fs,vol:{}}});
      return fs;
    }
    export function attachCompilerWorker(worker){
      const endpoint=createWasiFilesystemEndpoint(control,'thread-'+(++next));endpoints.push(endpoint);
      worker.postMessage({type:'filesystem-port',port:endpoint.port},[endpoint.port]);
      const lifecycle=()=>{};lifecycle.dispose=endpoint.dispose;
      manageWasiFilesystemWorker(worker,lifecycle);
    }`)
  routes.set('/control.mjs',`import {configure,endpoints} from '/provider.mjs';
    self.onmessage=async({data})=>{try{
      const fs=configure(data.port);fs.mkdirSync('/app/fixture',{recursive:true});
      for(let index=0;index<data.files;index++)fs.writeFileSync('/app/fixture/page-'+index+'.html','<div class="bg-blue-500 text-xl"></div>');
      postMessage({stage:'mounted'});
      const {Scanner,disposeBrowserOxideWorkers}=await import(${JSON.stringify('/'+oxide.path)});
      postMessage({stage:'binding-ready'});
      const scanner=new Scanner({sources:[{base:'/app',pattern:'fixture/**/*.html',negated:false}]});
      postMessage({stage:'scan-start'});
      const candidates=scanner.scan();
      postMessage({stage:'scan-end',candidates,files:scanner.files,spawnCalls:globalThis.__oxideSpawnCount??0});
      if(data.files){
        const path='/app/fixture/page-0.html';
        fs.writeFileSync(path,'<div class="underline italic"></div>');
        fs.utimesSync(path,new Date(),new Date(Date.now()+2000));
        const incremental=scanner.scan();
        postMessage({stage:'incremental',candidates:incremental,files:scanner.files,spawnCalls:globalThis.__oxideSpawnCount??0});
        fs.writeFileSync(path,'<div class="line-through uppercase"></div>');
        const changed=scanner.scanFiles([{file:path,extension:'html'}]);
        postMessage({stage:'changed-file-api',candidates:changed});
      }
      fs.writeFileSync('/app/fixture/new-file.html','<div class="font-bold"></div>');
      const fresh=new Scanner({sources:[{base:'/app',pattern:'fixture/**/*.html',negated:false}]});
      postMessage({stage:'fresh-discovery',candidates:fresh.scan(),files:fresh.files});
      disposeBrowserOxideWorkers();for(const endpoint of endpoints)endpoint.dispose();
      postMessage({stage:'disposed'});
    }catch(error){postMessage({stage:'error',error:String(error),stack:error.stack})}};`)
  const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
    'Cross-Origin-Resource-Policy':'cross-origin','Cache-Control':'no-store'}
  const server=createServer((request,response)=>{
    try{
      const source=routes.get(request.url)
      if(source!==undefined){response.writeHead(200,{...headers,'Content-Type':request.url.endsWith('.wasm')?'application/wasm':'text/javascript'});response.end(source);return}
      if(files.has(request.url)){
        response.writeHead(200,{...headers,'Content-Type':request.url.endsWith('.wasm')?'application/wasm':'text/javascript'})
        response.end(original(request.url));return
      }
      response.writeHead(200,{...headers,'Content-Type':'text/html'});response.end('<!doctype html><title>Live native scanner service control</title>')
    }catch(error){response.writeHead(500);response.end(String(error))}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{for(const name of ['chromium','firefox','webkit']){
    const browser=await engines[name].launch()
    try{
      const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port)
      const consoleMessages=[]
      page.on('console',message=>consoleMessages.push({type:message.type(),text:message.text()}))
      for(const count of [0,1,32,256]){
        const consoleStart=consoleMessages.length
        const result=await page.evaluate(count=>new Promise(resolve=>{
          const service=new Worker('/service.mjs',{type:'module'}),worker=new Worker('/control.mjs',{type:'module'}),rows=[]
          const finish=value=>{clearTimeout(timer);worker.terminate();service.terminate();resolve({...value,rows})}
          const timer=setTimeout(()=>finish({timeout:true}),15000)
          service.onerror=worker.onerror=event=>finish({error:event.message})
          service.onmessage=({data})=>{
            rows.push(data)
            if(data.stage==='service-ready'){
              const channel=new MessageChannel()
              service.postMessage({type:'control-port',port:channel.port1},[channel.port1])
              worker.postMessage({files:count,port:channel.port2},[channel.port2])
            }else if(data.stage==='service-state'){
              if(data.clients!==0||data.descriptors!==0){setTimeout(()=>service.postMessage({type:'inspect'}),10);return}
              finish({timeout:false})
            }
          }
          worker.onmessage=({data})=>{
            rows.push(data)
            if(data.stage==='error')finish({error:data.error})
            if(data.stage==='disposed')service.postMessage({type:'inspect'})
          }
        }),count)
        const row={browser:name,version:browser.version(),files:count,...result,console:consoleMessages.slice(consoleStart)}
        receipt.rows.push(row)
        console.log(JSON.stringify({...row,rows:row.rows.map(stage=>({...stage,files:stage.files?.length??stage.files}))}))
        row.controls={}
        const check=(name,fn)=>{try{fn();row.controls[name]=true}catch(error){row.controls[name]=false;
          failures.push(row.browser+' '+count+' '+name+': '+error);row.validationError=String(error)}}
        check('completion',()=>{
          assert.equal(result.timeout,false,JSON.stringify(result))
          assert.equal(result.error,undefined,JSON.stringify(result))
        })
        check('initialScan',()=>{
          const scan=result.rows.find(row=>row.stage==='scan-end')
          assert.ok(scan)
          assert.equal(scan.files.length,count)
          if(count)for(const candidate of ['bg-blue-500','text-xl'])assert.ok(scan.candidates.includes(candidate))
          else assert.deepEqual(scan.candidates,[])
        })
        if(count){
          check('changedFileAPI',()=>{
            const changed=result.rows.find(row=>row.stage==='changed-file-api')
            assert.ok(changed)
            for(const candidate of ['line-through','uppercase'])assert.ok(changed.candidates.includes(candidate),'Changed-file API missing '+candidate)
          })
          check('repeatedFullScan',()=>{
            const incremental=result.rows.find(row=>row.stage==='incremental')
            for(const candidate of ['underline','italic'])assert.ok(incremental.candidates.includes(candidate))
            assert.ok(incremental.files.includes('/app/fixture/page-0.html'))
          })
        }
        check('freshDiscovery',()=>{
          const discovery=result.rows.find(row=>row.stage==='fresh-discovery')
          assert.ok(discovery.candidates.includes('font-bold'))
          assert.ok(discovery.files.includes('/app/fixture/new-file.html'))
        })
        check('cleanup',()=>{
          const state=result.rows.at(-1);assert.equal(state.clients,0);assert.equal(state.descriptors,0)
        })
        row.passed=Object.values(row.controls).every(Boolean)
        save()
      }
    }finally{await browser.close()}
  }}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  receipt.passed=failures.length===0;save()
  assert.deepEqual(failures,[],'Native scanner service acceptance failures')
})
