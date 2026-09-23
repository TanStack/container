import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const sdkRoot=realpathSync(process.env.SDK_OUTPUT)
const fixtureRoot=resolve('fixtures/compiler-wasi/filesystem-case')
const names=['package.json','src/main.ts','src/value.ts','node_modules/fixture-condition/package.json','node_modules/fixture-condition/browser.js','node_modules/fixture-condition/default.js']
const files=Object.fromEntries(names.map(name=>['/project/'+name,readFileSync(resolve(fixtureRoot,name),'utf8')]))
const policy={experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
const diagnostic=process.env.ROLLDOWN_FS_DIAGNOSTICS==='1'
const workerObserver=`
    // Diagnostic fixture copy only, observe imports before instance creation.
    let observedCalls=0;
    for(const [name,fn]of Object.entries(wasi.wasiImport)){
      if(typeof fn!=='function')continue;
      wasi.wasiImport[name]=(...args)=>{
        const result=fn(...args);
        if((name==='path_open'||result!==0)&&observedCalls++<32){
          console.error('WASI_WORKER_DIAGNOSTIC '+JSON.stringify({name,args:args.map(v=>typeof v==='bigint'?v.toString()+'n':v),result}));
        }
        return result;
      };
    }
`
let server,url,snapshot
test.beforeAll(async()=>{
  snapshot=JSON.stringify(await collectInstalledClosure(resolve('fixtures/compiler-wasi'),['@rolldown/binding-wasm32-wasi']))
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
    try{if(!path.startsWith('/sdk/'))throw Error('outside SDK');const file=realpathSync(resolve(sdkRoot,decodeURIComponent(path.slice(5))));if(!file.startsWith(sdkRoot+sep))throw Error('outside SDK');res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})
const source=`(async()=>{
const evidence={cleanup:[]};let binding,bundler;
try{
 ${diagnostic?`const wasi=require('node:wasi');const OriginalWASI=wasi.WASI;evidence.wasi=[];wasi.WASI=class extends OriginalWASI{constructor(...args){super(...args);for(const [name,fn]of Object.entries(this.wasiImport)){if(typeof fn!=='function')continue;this.wasiImport[name]=(...values)=>{let result;try{result=fn(...values)}catch(error){if(evidence.wasi.length<256)evidence.wasi.push({name,args:values.map(v=>typeof v==='bigint'?v.toString()+'n':v),threw:error.message});throw error}if((name==='path_open'||result!==0)&&evidence.wasi.length<256)evidence.wasi.push({name,args:values.map(v=>typeof v==='bigint'?v.toString()+'n':v),result:typeof result==='bigint'?result.toString()+'n':result});return result}}}};`:''}
 binding=require('@rolldown/binding-wasm32-wasi');binding.startAsyncRuntime();bundler=new binding.BindingBundler();
 const output=await bundler.generate({inputOptions:{input:[{name:'main',import:'./src/main.ts'}],plugins:[],cwd:process.cwd(),platform:'browser',logLevel:binding.BindingLogLevel.Silent,onLog:()=>{}},outputOptions:{plugins:[],format:'cjs',entryFileNames:'bundle.cjs',dir:'dist',sourcemap:'file'}});
 if(output.isBindingErrors)throw Error(JSON.stringify(output.errors));
 evidence.chunks=output.chunks.map(c=>({code:c.getCode(),fileName:c.getFileName(),exports:c.getExports(),imports:c.getImports(),moduleIds:c.getModuleIds(),map:c.getMap()?JSON.parse(c.getMap()):null}));
 const module={exports:{}};new Function('module','exports',evidence.chunks[0].code)(module,module.exports);evidence.executed=module.exports;
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
finally{if(bundler)try{await bundler.close()}catch(error){evidence.cleanup.push(error.message)}if(binding)try{binding.shutdownAsyncRuntime()}catch(error){evidence.cleanup.push(error.message)}}
// Normalize only the execution root, retaining source content and mappings.
return JSON.parse(JSON.stringify(evidence).split(process.cwd()).join('$ROOT'));
})().then(value=>{console.log(JSON.stringify(value));process.exit(value.failure||value.cleanup.length?1:0)},error=>{console.error(error.stack);process.exit(1)});`

test('packaged Rolldown resolves filesystem TS and conditional package exports with sourcemaps',async({page},info)=>{
  test.setTimeout(60000)
  const native=spawnSync(process.execPath,['-e',source],{cwd:fixtureRoot,encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-filesystem.json');await writeFile(nativePath,JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message},null,2))
  await info.attach('native-filesystem.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected.executed).toEqual({result:42,selected:'browser'})
  expect(expected.chunks).toHaveLength(1)
  const chunk=expected.chunks[0]
  expect(chunk.code).not.toContain('UNUSED_FILESYSTEM_SENTINEL')
  expect(chunk.map.sources.some(path=>path.endsWith('src/main.ts'))).toBe(true)
  expect(chunk.map.sourcesContent).toContain(files['/project/src/main.ts'])
  expect(chunk.map.mappings.length).toBeGreaterThan(0)
  expect(chunk.moduleIds.some(path=>path.endsWith('fixture-condition/browser.js'))).toBe(true)
  expect(chunk.moduleIds.some(path=>path.endsWith('fixture-condition/default.js'))).toBe(false)
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async({source,files,policy,diagnostic,workerObserver})=>{
    const closure=await fetch('/fixture.json').then(r=>r.json())
    const inputs=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
    if(diagnostic){
      const path='/project/node_modules/@rolldown/binding-wasm32-wasi/wasi-worker.mjs'
      const original=new TextDecoder().decode(inputs[path])
      const anchor='    return instantiateNapiModuleSync(wasmModule, {'
      if(original.split(anchor).length!==2)throw Error('Unexpected diagnostic worker source')
      inputs[path]=new TextEncoder().encode(original.replace(anchor,workerObserver+'\n'+anchor))
    }
    Object.assign(inputs,files,{'/project/main.cjs':source})
    const kernel=new window.sdk.WorkerKernel(inputs,policy);const output=[];let result,error,closeError
    try{result=await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000,onOutput:(level,text)=>output.push({level,text})})}catch(e){error={name:e.name,message:e.message}}
    finally{try{kernel.close()}catch(e){closeError=e.message}}
    return {result,error,closeError,output}
  },{source,files,policy,diagnostic,workerObserver})
  const guestPath=info.outputPath(diagnostic?'guest-filesystem-diagnostic.json':'guest-filesystem.json');await writeFile(guestPath,JSON.stringify({sdkRoot,policy,diagnostic,scope:diagnostic?'Diagnostic in-memory worker fixture instrumentation, not unchanged-package acceptance':'Unchanged-package acceptance',expected,observed},null,2));await info.attach('guest-filesystem.json',{path:guestPath,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
  const actual=JSON.parse(observed.result.stdout)
  if(diagnostic){delete actual.wasi;delete expected.wasi}
  expect(actual).toEqual(expected)
  expect(observed.closeError).toBeUndefined()
})
