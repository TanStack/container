import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'

test('filesystem startup lets the installed Oxide scanner run without booting Rolldown',{
  skip:process.env.NATIVE_OXIDE_SCANNER_CONTROL!=='1'?'Opt-in actual Oxide scanner control':false,
  timeout:180000,
},async()=>{
  const root=resolve('.'),deployment=resolve(process.env.NATIVE_DEPLOYMENT_DIR)
  const diagnosticPool=process.env.NATIVE_OXIDE_SCANNER_POOL===undefined?undefined:Number(process.env.NATIVE_OXIDE_SCANNER_POOL)
  if(diagnosticPool!==undefined)assert.ok(Number.isSafeInteger(diagnosticPool)&&diagnosticPool>=1&&diagnosticPool<=8)
  const diagnosticYield=process.env.NATIVE_OXIDE_SCANNER_YIELD==='1'
  const requireCompletion=process.env.NATIVE_OXIDE_SCANNER_REQUIRE_THREAD_COMPLETION==='1'
  const receiptDirectory=mkdtempSync(join(tmpdir(),'native-oxide-owner-'))
  const receipt={passed:false,deployment,diagnosticPool,diagnosticYield,requireCompletion,cases:[],overlays:{},
    inputs:{testSha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')}}
  const saveReceipt=()=>writeFileSync(join(receiptDirectory,'results.json'),JSON.stringify(receipt,null,2)+'\n')
  saveReceipt()
  console.log('Scanner receipt: '+join(receiptDirectory,'results.json'))
  const require=createRequire(join(resolve(process.env.NATIVE_COMPILER_FS_PLAYWRIGHT_ROOT),'package.json'))
  assert.equal(require('@playwright/test/package.json').version,'1.63.0')
  const {chromium,firefox,webkit}=require('@playwright/test')
  const manifest=JSON.parse(readFileSync(join(deployment,'deployment-manifest.json')))
  receipt.inputs.deploymentManifestSha256=createHash('sha256').update(readFileSync(join(deployment,'deployment-manifest.json'))).digest('hex')
  const oxide=manifest.files.find(file=>file.path.startsWith('runtime/native/vite-8.3.1-')&&file.path.endsWith('/oxide/oxide.mjs'))
  assert.ok(oxide,'Missing installed Oxide binding')
  const ownerPath=oxide.path.slice(0,-'/oxide/oxide.mjs'.length)+'/filesystem-owner.mjs'
  assert.ok(manifest.files.some(file=>file.path===ownerPath),'Missing independent filesystem owner')
  receipt.inputs.filesystemOwnerSha256=manifest.files.find(file=>file.path===ownerPath).sha256
  receipt.inputs.oxideBindingSha256=oxide.sha256
  const files=new Map(manifest.files.map(file=>['/'+file.path,file]))
  const candidatePath=process.env.NATIVE_OXIDE_SCANNER_WASM
  const candidateHash=process.env.NATIVE_OXIDE_SCANNER_WASM_SHA256
  assert.equal(Boolean(candidatePath),Boolean(candidateHash),'Candidate requires a path and SHA-256')
  let candidate
  if(candidatePath){
    candidate=readFileSync(resolve(candidatePath))
    assert.match(candidateHash,/^[a-f0-9]{64}$/)
    assert.equal(createHash('sha256').update(candidate).digest('hex'),candidateHash)
    assert.equal(WebAssembly.validate(candidate),true)
  }
  const wasmPath=oxide.path.slice(0,-'/oxide.mjs'.length)+'/tailwindcss-oxide.wasm32-wasi.wasm'
  assert.ok(files.has('/'+wasmPath),'Missing installed Oxide WASM')
  receipt.inputs.installedOxideWasmSha256=files.get('/'+wasmPath).sha256
  if(candidate)receipt.inputs.candidateOxideWasmSha256=candidateHash
  receipt.diagnostic=Boolean(candidate||diagnosticPool!==undefined||diagnosticYield)
  const projectRequire=createRequire(import.meta.url)
  const codecRoot=resolve(projectRequire.resolve('@napi-rs/wasm-runtime'),'..')
  assert.equal(JSON.parse(readFileSync(join(codecRoot,'package.json'))).version,'1.2.4')
  const provider=await build({stdin:{contents:`
    export {bootstrapNativeFilesystem} from './src/native/filesystem-bootstrap.ts';
    export {linkNativeFilesystemWorker} from './src/native/filesystem-worker-link.mjs';
    export async function mountFiles(files){
      const {resetVolume,vol,default:fs}=await import('./src/vite-browser/node-fs.ts');
      resetVolume(files);
      return fs;
    }
  `,resolveDir:root,sourcefile:'oxide-filesystem-control.mjs'},platform:'browser',bundle:true,
    write:false,metafile:true,format:'esm',target:'es2022',alias:{'node:buffer':'buffer/','node:events':'events/',
      'node:stream':'stream-browserify','node:path':'path-browserify'},plugins:[{
      name:'pinned-control-filesystem-codec',setup(bundler){
        bundler.onResolve({filter:/^tanstack:filesystem-codec-124$/},()=>({path:join(codecRoot,'fs-proxy.js')}));
        bundler.onLoad({filter:/fs-proxy\.js$/},async args=>({
          contents:replaceWasiFsProxy(readFileSync(args.path,'utf8'),join(root,'src/native/wasi-fs-transport.mjs')),
          loader:'js',resolveDir:codecRoot,
        }));
      },
    }]})
  const compilerInputs=Object.keys(provider.metafile.inputs).filter(path=>/(?:rolldown|oxide)/.test(path)&&path!=='oxide-filesystem-control.mjs')
  assert.deepEqual(compilerInputs,[],'Filesystem startup must not load a compiler')
  receipt.inputs.compilerInputs=compilerInputs
  receipt.inputs.filesystemControlSha256=createHash('sha256').update(provider.outputFiles[0].text).digest('hex')
  const worker=`import {bootstrapNativeFilesystem,mountFiles} from '/provider.mjs';
    await bootstrapNativeFilesystem();
    postMessage({stage:'filesystem-connected'});
    const count=Number(new URL(self.location.href).searchParams.get('files'));
    {
      try{
        const fs=await mountFiles(Object.fromEntries(Array.from({length:count},(_,index)=>
          ['/app/fixture/page-'+index+'.html','<div class="bg-blue-500 text-xl"></div>'])));
        fs.mkdirSync('/app/fixture',{recursive:true});
        postMessage({stage:'mounted'});
        const {Scanner,disposeBrowserOxideWorkers,inspectBrowserOxideWorkers}=await import(${JSON.stringify('/'+oxide.path)});
        postMessage({stage:'binding-ready'});
        const scanner=new Scanner({sources:[{base:'/app',pattern:'fixture/**/*.html',negated:false}]});
        postMessage({stage:'scan-start'});
        const candidates=scanner.scan();
        postMessage({stage:'scan-returned'});
        const files=scanner.files;
        postMessage({stage:'initial-scan',candidates,files});
        if(count){
          const path='/app/fixture/page-0.html';
          const edit=(content,offset)=>{
            fs.writeFileSync(path,content);
            fs.utimesSync(path,new Date(),new Date(Date.now()+offset));
          };
          edit('<div class="underline italic"></div>',2000);
          postMessage({stage:'repeated-scan',candidates:scanner.scan(),files:scanner.files});
          for(let iteration=0;iteration<10;iteration++){
            ${diagnosticYield?'await new Promise(resolve=>setTimeout(resolve,0));':''}
            const className='opacity-'+(iteration+1)*5;
            edit('<div class="'+className+'"></div>',6000+iteration*2000);
            postMessage({stage:'repeat-sequence',iteration,className,candidates:scanner.scan(),files:scanner.files});
          }
          edit('<div class="line-through uppercase"></div>',4000);
          postMessage({stage:'changed-file',candidates:scanner.scanFiles([{file:path,extension:'html'}])});
        }
        fs.writeFileSync('/app/fixture/new-file.html','<div class="font-bold"></div>');
        const fresh=new Scanner({sources:[{base:'/app',pattern:'fixture/**/*.html',negated:false}]});
        postMessage({stage:'fresh-discovery',candidates:fresh.scan(),files:fresh.files});
        const pool=inspectBrowserOxideWorkers?.();
        disposeBrowserOxideWorkers();
        postMessage({stage:'scan-end',pool,disposedPool:inspectBrowserOxideWorkers?.()});
      }catch(error){postMessage({stage:'error',error:String(error),stack:error.stack})}
    }`
  const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
    'Cross-Origin-Resource-Policy':'cross-origin','Cache-Control':'no-store'}
  const server=createServer((request,response)=>{
    try{
      const pathname=new URL(request.url,'http://localhost').pathname
      const file=files.get(pathname)
      if(file){
        let bytes=readFileSync(join(deployment,file.path))
        assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256)
        if(file.path===wasmPath&&candidate)bytes=candidate
        if(file.path===oxide.path&&diagnosticPool!==undefined){
          const contents=bytes.toString()
          const original=/asyncWorkPoolSize: ([12]),\n  reuseWorker: \{ size: \1, strict: true \},/g
          assert.equal([...contents.matchAll(original)].length,1,'Pinned Oxide worker pool changed')
          bytes=Buffer.from(contents.replace(original,`asyncWorkPoolSize: ${diagnosticPool},\n  reuseWorker: { size: ${diagnosticPool}, strict: true },`))
        }
        const servedHash=createHash('sha256').update(bytes).digest('hex')
        if(servedHash!==file.sha256)receipt.overlays[file.path]={originalSha256:file.sha256,servedSha256:servedHash}
        response.writeHead(200,{...headers,'Content-Type':file.path.endsWith('.wasm')?'application/wasm':'text/javascript'})
        response.end(bytes);return
      }
      const script=pathname==='/provider.mjs'?provider.outputFiles[0].text:pathname==='/control.mjs'?worker:undefined
      response.writeHead(200,{...headers,'Content-Type':script?'text/javascript':'text/html'})
      response.end(script??'<!doctype html><title>Actual Oxide scanner control</title>')
    }catch(error){response.writeHead(500);response.end(String(error))}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const failures=[]
  try{
    for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
    const page=await browser.newPage()
    const consoleRows=[]
    page.on('console',message=>{consoleRows.push({type:message.type(),text:message.text()});if(consoleRows.length>64)consoleRows.shift()})
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    for(const files of [0,1,32,256]){
      consoleRows.length=0
      const result=await page.evaluate(async({files,ownerPath})=>{
        const {linkNativeFilesystemWorker}=await import('/provider.mjs')
        return new Promise(resolve=>{
        const owner=new Worker('/'+ownerPath,{type:'module'}),worker=new Worker('/control.mjs?files='+files,{type:'module'}),rows=[]
        const link=linkNativeFilesystemWorker(worker,{id:'scanner',control:owner})
        let finishing=false
        const stop=()=>{link.dispose();worker.terminate();owner.terminate()}
        const timer=setTimeout(()=>{stop();resolve({timeout:true,rows})},15000)
        owner.onmessage=({data})=>{
          if(data.type!=='native-filesystem-inspect')return
          clearTimeout(timer);stop();resolve({timeout:false,rows,cleanup:data})
        }
        worker.onmessage=({data})=>{
          rows.push(data)
          if(!finishing&&(data.stage==='scan-end'||data.stage==='error')){
            finishing=true;link.dispose();worker.terminate();owner.postMessage({type:'native-filesystem-inspect'})
          }
        }
        const failure=event=>{
          clearTimeout(timer);stop();resolve({timeout:false,error:event.message,rows})
        }
        worker.onerror=failure;owner.onerror=failure
      })},{files,ownerPath})
      if(consoleRows.length)result.console=consoleRows.slice()
      receipt.cases.push({browser:engine.name(),version:browser.version(),files,...result})
      saveReceipt()
      console.log(JSON.stringify({browser:engine.name(),version:browser.version(),files,
        ...result,rows:result.rows.map(row=>({...row,...(Array.isArray(row.files)?{files:row.files.length}:{})}))}))
      try{
      assert.equal(result.timeout,false)
      assert.equal(result.error,undefined)
      const end=result.rows.at(-1)
      assert.equal(end.stage,'scan-end',JSON.stringify(end))
      if(requireCompletion){
        assert.equal(end.pool.allocations,2,'Native worker count must remain bounded')
        assert.equal(end.disposedPool.disposed,true)
        assert.equal(end.disposedPool.workers,0)
        if(files)assert.ok(end.pool.reclaims>=10,'Consecutive scans must reclaim native workers synchronously')
      }
      const initial=result.rows.find(row=>row.stage==='initial-scan')
      assert.equal(new Set(initial.files).size,files)
      if(files){
        assert.ok(initial.candidates.includes('bg-blue-500'))
        assert.ok(initial.candidates.includes('text-xl'))
        assert.ok(initial.files.includes('/app/fixture/page-0.html'))
        const repeated=result.rows.find(row=>row.stage==='repeated-scan')
        for(const className of ['underline','italic'])assert.ok(repeated.candidates.includes(className),'Repeated full scan: '+className)
        assert.equal(new Set(repeated.files).size,files)
        const changed=result.rows.find(row=>row.stage==='changed-file')
        for(const className of ['line-through','uppercase'])assert.ok(changed.candidates.includes(className),'Changed-file API: '+className)
        const sequence=result.rows.filter(row=>row.stage==='repeat-sequence')
        assert.equal(sequence.length,10,'Repeated-scan sequence must finish')
        for(const row of sequence){
          assert.ok(row.candidates.includes(row.className),'Repeated-scan sequence: '+row.iteration)
          assert.equal(new Set(row.files).size,files)
        }
      }else assert.deepEqual(initial.candidates,[])
      const discovery=result.rows.find(row=>row.stage==='fresh-discovery')
      assert.ok(discovery.candidates.includes('font-bold'))
      assert.ok(discovery.files.includes('/app/fixture/new-file.html'))
      assert.equal(new Set(discovery.files).size,files+1)
      for(const key of ['clients','descriptors','watches','controls'])assert.equal(result.cleanup[key],0,'Cleanup: '+key)
      }catch(error){failures.push({browser:engine.name(),files,error:String(error)})}
    }
    }finally{await browser.close()}
    }
    receipt.failures=failures
    receipt.passed=failures.length===0&&receipt.cases.length===12
    saveReceipt()
    assert.equal(receipt.passed,true,JSON.stringify(failures))
  }finally{saveReceipt();await new Promise(resolve=>server.close(resolve))}
})
