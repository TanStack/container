import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const sdkRoot=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(sdkRoot,'manifest.json'),'utf8'))
const wasmCSS=process.env.VITE_WASM_CSS==='1'
const phaseEvidence=wasmCSS&&process.env.VITE_PHASE_EVIDENCE==='1'
const preloadCSS=process.env.VITE_PRELOAD_CSS==='1'
if(preloadCSS&&!wasmCSS)throw Error('CSS preload diagnostic requires VITE_WASM_CSS=1')
const dependencyRoot=resolve(wasmCSS?'fixtures/vite-rolldown-wasm':'fixtures/workloads')
const bindingRoot=resolve(wasmCSS?'fixtures/vite-rolldown-wasm':'fixtures/compiler-wasi')
const dependencyProfile=wasmCSS?'Declared lightningcss npm:lightningcss-wasm@1.33 alias and override, not unchanged native LightningCSS support':'Original installed Vite dependency profile'
const projectRoot=resolve('fixtures/vite-rolldown-basic')
const project=Object.fromEntries(['index.html','main.ts','style.css','value.ts'].map(name=>['/project/app/'+name,readFileSync(resolve(projectRoot,name),'utf8')]))
const nativeBinding=resolve(bindingRoot,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
const guestBinding='/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'
const policy={experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let server,url,fixture,preparation
test.beforeAll(async()=>{
  const vite=await collectInstalledClosure(dependencyRoot,['vite'])
  const wasi=await collectInstalledClosure(bindingRoot,['@rolldown/binding-wasm32-wasi'])
  const overlaps=Object.keys(vite.files).filter(path=>Object.hasOwn(wasi.files,path))
  for(const path of overlaps)if(vite.files[path].base64!==wasi.files[path].base64)throw Error('Conflicting closure file: '+path)
  preparation={vite:vite.preparation,wasi:wasi.preparation,identicalOverlaps:overlaps}
  fixture=JSON.stringify({files:{...vite.files,...wasi.files}})
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(fixture);return}
    try{if(!path.startsWith('/sdk/'))throw Error('outside SDK');const file=realpathSync(resolve(sdkRoot,decodeURIComponent(path.slice(5))));if(!file.startsWith(sdkRoot+sep))throw Error('outside SDK');res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

function buildSource(importPath,root,cssMinify){return `const evidence={stages:[]${phaseEvidence?',memory:[]':''}};
const phase=name=>{evidence.stages.push(name);${phaseEvidence?`try{const snapshot=process.memoryUsage(),usage={};for(const key of ['rss','heapTotal','heapUsed','external','arrayBuffers']){try{usage[key]=snapshot[key]}catch(error){usage[key]={unavailable:error.message}}}evidence.memory.push({phase:name,usage})}catch(error){evidence.memory.push({phase:name,error:error.message})}`:''}console.log('VITE_PHASE:'+name)};
${phaseEvidence?`const errorEvidence=(error,depth=0)=>{if(depth>3)return {truncated:true};if(!error||typeof error!=='object')return {value:String(error)};const value={name:error.name,message:error.message,stack:error.stack};if(error.cause!==undefined)value.cause=errorEvidence(error.cause,depth+1);if(Array.isArray(error.errors))value.errors=error.errors.slice(0,8).map(item=>errorEvidence(item,depth+1));return value};`:''}
try{
 phase('before-import');const {build}=await import(${JSON.stringify(importPath)});phase('imported');
 ${preloadCSS?`phase('before-css-preload');await import(${JSON.stringify(importPath==='vite'?'lightningcss':pathToFileURL(resolve(dependencyRoot,'node_modules/lightningcss/wasm-node.mjs')).href)});phase('css-preloaded');`:''}
 ${phaseEvidence?`phase('before-build');`:''}
 const result=await build({root:${JSON.stringify(root)},configFile:false,logLevel:'silent',build:{write:false,sourcemap:true${cssMinify===false?',cssMinify:false':''}}});phase('built');
 const outputs=(Array.isArray(result)?result:[result]).flatMap(item=>item.output);
 evidence.outputs=outputs.map(item=>({type:item.type,fileName:item.fileName,content:item.type==='chunk'?item.code:typeof item.source==='string'?item.source:Buffer.from(item.source).toString('utf8')}));
}catch(error){evidence.failure=${phaseEvidence?'errorEvidence(error)':'{name:error.name,message:error.message,stack:error.stack}'};${phaseEvidence?`phase('failed');`:''}}
console.log(JSON.stringify(evidence));process.exit(evidence.failure?1:0);`}
function verifyOutputs(outputs){
  expect(outputs.some(item=>item.fileName==='index.html'&&item.content.includes('type="module"'))).toBe(true)
  expect(outputs.some(item=>item.fileName.endsWith('.css')&&item.content.includes('#app'))).toBe(true)
  expect(outputs.some(item=>item.type==='chunk'&&item.content.includes('vite-rolldown-ready:'))).toBe(true)
  expect(outputs.some(item=>item.fileName.endsWith('.map')&&JSON.parse(item.content).version===3)).toBe(true)
  expect(outputs.every(item=>item.type!=='chunk'||!item.content.includes('UNUSED_VITE_FIXTURE'))).toBe(true)
}
for(const cssMinify of [undefined,false])test(`packaged Vite8 build ${cssMinify===false?'diagnostic cssMinify:false, not default acceptance':'default options'}${preloadCSS?' with CSS preload diagnostic, not acceptance':''}`,async({page},info)=>{
  test.skip(!['experimental-fibers-simd','experimental-fibers-simd-lazy'].includes(manifest.buildProfile),'Requires an explicit SIMD fiber SDK profile')
  test.setTimeout(60000)
  const source=buildSource('vite','/project/app',cssMinify)
  const nativeSource=buildSource(pathToFileURL(resolve(dependencyRoot,'node_modules/vite/dist/node/index.js')).href,projectRoot,cssMinify)
  const native=spawnSync(process.execPath,['--input-type=module','-e',nativeSource],{env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:nativeBinding},encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-vite-build.json');await writeFile(nativePath,JSON.stringify({dependencyProfile,dependencyRoot,status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message,cssMinify:cssMinify??'default'},null,2));await info.attach('native-vite-build.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout.trim().split('\n').at(-1));verifyOutputs(expected.outputs)
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async({source,project,policy,guestBinding})=>{
    const closure=await fetch('/fixture.json').then(r=>r.json())
    const files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
    Object.assign(files,project,{'/project/main.mjs':source})
    let kernel,result,error,closeError;const output=[]
    try{kernel=new window.sdk.WorkerKernel(files,policy);result=await kernel.runModule('/project/main.mjs',{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:guestBinding},guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000,onOutput:(level,text)=>output.push({level,text})})}catch(e){error={name:e.name,message:e.message}}
    finally{if(kernel)try{kernel.close()}catch(e){closeError=e.message}}
    return {result,error,closeError,output}
  },{source,project,policy,guestBinding})
  const path=info.outputPath('guest-vite-build.json');await writeFile(path,JSON.stringify({sdkRoot,dependencyProfile,dependencyRoot,phaseEvidence,preloadCSS,scope:preloadCSS?'Startup preload diagnostic, not unchanged-order acceptance':'Original build ordering',policy,preparation,cssMinify:cssMinify??'default',expected,observed},null,2));await info.attach('guest-vite-build.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
  const actual=JSON.parse(observed.result.stdout.trim().split('\n').at(-1));verifyOutputs(actual.outputs)
  if(phaseEvidence){delete actual.memory;delete expected.memory}
  const normalized=value=>JSON.parse(JSON.stringify(value).split(projectRoot).join('$ROOT').split('/project/app').join('$ROOT'))
  expect(normalized(actual)).toEqual(normalized(expected))
  expect(observed.closeError).toBeUndefined()
})
