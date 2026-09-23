import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const guestBinding='/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'
const nativeBinding=resolve('fixtures/compiler-wasi/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
const policy={experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let server,url,fixtures,preparation
test.beforeAll(async()=>{
  const publicPackage=await collectInstalledClosure(resolve('fixtures/workloads'),['rolldown'])
  const wasiPackage=await collectInstalledClosure(resolve('fixtures/compiler-wasi'),['@rolldown/binding-wasm32-wasi'])
  const overlaps=Object.keys(publicPackage.files).filter(path=>Object.hasOwn(wasiPackage.files,path))
  for(const path of overlaps)if(publicPackage.files[path].base64!==wasiPackage.files[path].base64)throw Error('Conflicting installed dependency closure file: '+path)
  preparation={publicPackage:publicPackage.preparation,wasiPackage:wasiPackage.preparation,identicalOverlaps:overlaps}
  fixtures=JSON.stringify({files:{...publicPackage.files,...wasiPackage.files}})
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(fixtures);return}
    try{if(!path.startsWith('/sdk/'))throw Error('outside package');const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))));if(!file.startsWith(root+sep))throw Error('outside package');res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

// Same public API workload as scripts/probe-rolldown-public.mjs.
const source=`const evidence={stages:[],cleanup:[]};let bundle;
try{
 evidence.stages.push('before-import');const {rolldown}=await import('rolldown');evidence.stages.push('imported');
 const modules={'virtual:main':'import {answer} from "virtual:dep"; export const result=answer+1;','virtual:dep':'export const answer=41; export const unused=999;'};
 bundle=await rolldown({input:'virtual:main',plugins:[{name:'local-fixture',resolveId(id){if(id in modules)return id},load(id){return modules[id]}}]});
 evidence.stages.push('created');const {output}=await bundle.generate({format:'es'});evidence.stages.push('generated');
 const chunks=output.filter(item=>item.type==='chunk');if(chunks.length!==1)throw Error('Expected one chunk');
 const executed=await import('data:text/javascript;base64,'+Buffer.from(chunks[0].code).toString('base64'));
 evidence.result=executed.result;evidence.exports=chunks[0].exports;evidence.treeShaken=!chunks[0].code.includes('999');evidence.stages.push('executed');
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
finally{if(bundle)try{await bundle.close();evidence.stages.push('closed')}catch(error){evidence.cleanup.push({name:error.name,message:error.message})}}
console.log(JSON.stringify(evidence));process.exit(evidence.failure||evidence.cleanup.length?1:0);`

test('packaged public Rolldown API bundles through supported WASI selection with native parity',async({page},info)=>{
  test.skip(!['experimental-fibers-simd','experimental-fibers-simd-lazy'].includes(manifest.buildProfile),'Requires SIMD fiber package')
  test.setTimeout(60000)
  const native=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:resolve('fixtures/workloads'),env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:nativeBinding},encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-rolldown-public.json')
  await writeFile(nativePath,JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message,binding:nativeBinding},null,2));await info.attach('native-rolldown-public.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected).toMatchObject({result:42,exports:['result'],treeShaken:true,cleanup:[],stages:['before-import','imported','created','generated','executed','closed']})
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async({source,policy,guestBinding})=>{
    const snapshot=await fetch('/fixture.json').then(r=>r.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
    files['/project/main.mjs']=source
    const kernel=new window.sdk.WorkerKernel(files,policy);const output=[];let result,error,closeError
    try{result=await kernel.runModule('/project/main.mjs',{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:guestBinding},guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000,onOutput:(level,text)=>output.push({level,text})})}catch(e){error={name:e.name,message:e.message}}
    finally{try{kernel.close()}catch(e){closeError={message:e.message}}}
    return {result,error,closeError,output}
  },{source,policy,guestBinding})
  const path=info.outputPath('guest-rolldown-public.json');await writeFile(path,JSON.stringify({root,policy,guestBinding,preparation,expected,observed},null,2));await info.attach('guest-rolldown-public.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
  expect(JSON.parse(observed.result.stdout)).toEqual(expected)
  expect(observed.closeError).toBeUndefined()
})
