import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname,basename} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
let server,url,snapshot
test.beforeAll(async()=>{
  snapshot=JSON.stringify(await collectInstalledClosure(resolve('fixtures/compiler-wasi'),['@rolldown/binding-wasm32-wasi']))
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

const source=`(async()=>{
const evidence={chunks:[],cleanup:[]};let binding,bundler;
try{
 binding=require('@rolldown/binding-wasm32-wasi');binding.startAsyncRuntime();bundler=new binding.BindingBundler();
 const output=await bundler.generate({inputOptions:{input:[{name:'main',import:'/project/main.tsx'}],cwd:'/project',platform:'neutral',logLevel:binding.BindingLogLevel.Silent,onLog:()=>{},transform:{jsx:{runtime:'classic',pragma:'h'}},plugins:[]},outputOptions:{plugins:[],format:'es',entryFileNames:'main.mjs',chunkFileNames:'[name]-[hash].mjs',sourcemap:'file'}});
 if(output.isBindingErrors)throw Error(JSON.stringify(output.errors));
 const fs=require('node:fs');fs.mkdirSync('/project/out',{recursive:true});
 evidence.chunks=output.chunks.map(chunk=>{
 const fileName=chunk.getFileName(),code=chunk.getCode(),map=chunk.getMap();
 fs.writeFileSync('/project/out/'+fileName,code);fs.writeFileSync('/project/out/'+fileName+'.map',map);
 return {fileName,code,map:JSON.parse(map)};
 });
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
 if(bundler)try{await bundler.close()}catch(error){evidence.cleanup.push({stage:'close',message:error.message})}
 if(binding)try{binding.shutdownAsyncRuntime()}catch(error){evidence.cleanup.push({stage:'shutdown',message:error.message})}
}
console.log(JSON.stringify(evidence));process.exit(evidence.failure||evidence.cleanup.length?1:0);
})().catch(error=>{console.error(error.stack);process.exit(1)});`

test('packaged Rolldown compiles filesystem TSX, split chunks and maps, then executes dynamic import',async({page},info)=>{
  const native=spawnSync(process.execPath,['scripts/probe-rolldown-tsx.mjs','--filesystem'],{encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-tsx.json')
  await writeFile(nativePath,JSON.stringify({status:native.status,signal:native.signal,error:native.error?.message,stdout:native.stdout,stderr:native.stderr},null,2))
  await info.attach('native-tsx.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected.filesystem).toBe(true)
  const inputs=Object.fromEntries(['main.tsx','lazy.ts'].map(name=>[name,readFileSync(resolve('fixtures/rolldown-tsx',name),'utf8')]))
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const execution=await page.evaluate(async({source,inputs})=>{
    const evidence={compile:null,execute:null,error:null,output:[]};let kernel
    try{
      const snapshot=await fetch('/fixture.json').then(r=>r.json())
      const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
      for(const [name,text] of Object.entries(inputs))files['/project/'+name]=text
      files['/project/compile.cjs']=source
      files['/project/execute.mjs']="import {view,loadAnswer} from './out/main.mjs'; console.log(JSON.stringify({view,dynamicResult:await loadAnswer()}));"
      kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},maxBytes:128*1024*1024,timeoutMs:15000,workspace:{maxBytes:64*1024*1024}})
      evidence.compile=await kernel.runModule('/project/compile.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:128*1024*1024,timeoutMs:15000,onOutput:(level,text)=>evidence.output.push({level,text})})
      if(evidence.compile.exitCode===0)evidence.execute=await kernel.runModule('/project/execute.mjs',{cwd:'/project',timeoutMs:15000,maxBytes:128*1024*1024})
    }catch(error){evidence.error={name:error.name,message:error.message,stack:error.stack}}
    finally{if(kernel)kernel.close()}
    return evidence
  },{source,inputs})
  const evidencePath=info.outputPath('packaged-tsx.json')
  await writeFile(evidencePath,JSON.stringify({sdk:root,version:expected.version,nativeControlUsesVirtualFixtureLoader:false,guestUsesFilesystem:true,expected,...execution},null,2))
  await info.attach('packaged-tsx.json',{path:evidencePath,contentType:'application/json'})
  expect(execution.error,JSON.stringify(execution)).toBeNull()
  expect(execution.compile.exitCode,execution.compile.stderr||execution.compile.stdout).toBe(0)
  const compiled=JSON.parse(execution.compile.stdout)
  expect(compiled.failure).toBeUndefined();expect(compiled.cleanup).toEqual([])
  expect(compiled.chunks.length).toBeGreaterThanOrEqual(2)
  for(const chunk of compiled.chunks){expect(chunk.map.version).toBe(3);expect(chunk.map.sources.length).toBeGreaterThan(0);expect(chunk.map.mappings.length).toBeGreaterThan(0)}
  // Source roots differ between native disk and the guest workspace.
  const sources=chunks=>chunks.flatMap(chunk=>(chunk.map?.sources??chunk.sources).map(name=>basename(name))).sort()
  expect(sources(compiled.chunks)).toEqual(sources(expected.chunks))
  expect(execution.execute.exitCode,execution.execute.stderr).toBe(0)
  expect(JSON.parse(execution.execute.stdout)).toEqual({view:expected.view,dynamicResult:expected.dynamicResult})
  expect(JSON.parse(execution.execute.stdout)).toEqual({view:{tag:'output',props:{answer:42},children:['ready']},dynamicResult:42})
})
