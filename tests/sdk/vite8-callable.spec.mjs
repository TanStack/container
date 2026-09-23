import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync,mkdtempSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const guestBinding='/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'
const nativeBinding=resolve('fixtures/vite-rolldown-wasm/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
const policy={experimentalFibers:true,maxBytes:128*1024*1024,workerMaxBytes:64*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let server,url,fixtures,preparation
test.beforeAll(async()=>{
  const publicPackage=await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['vite'])
  const wasiPackage=await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['@rolldown/binding-wasm32-wasi'])
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

// Exercise the callable bridge after a real Vite server has initialized.
const source=`const evidence={stages:[],results:[]};let server;const phase=name=>{evidence.stages.push(name);console.log('PHASE:'+name)};
try{phase('before-import');const {createServer}=await import('vite');const {oxcRuntimePlugin}=await import('rolldown/experimental');const fs=await import('node:fs');const root=process.cwd()+'/callable-app';fs.mkdirSync(root,{recursive:true});fs.writeFileSync(root+'/index.html','<script type="module" src="/main.ts"></script>');fs.writeFileSync(root+'/main.ts','export const value: number = 42');
server=await createServer({root,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();phase('ready');
const plugin=oxcRuntimePlugin(),handler=typeof plugin.transform==='function'?plugin.transform:plugin.transform.handler;
phase('before-callable');const result=await handler.call({},'export * from "@tanstack/react-start-server";',root+'/server.js',{ssr:true,moduleType:'js'});evidence.results.push(result===undefined?{undefined:true}:result);phase('after-callable');
phase('before-ssr-transform');const transformed=await server.environments.ssr.transformRequest('/main.ts');evidence.transformed=transformed.code;phase('after-ssr-transform');
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}finally{if(server)try{await server.close();phase('closed')}catch(error){evidence.closeError=error.message}}console.log(JSON.stringify(evidence));process.exit(evidence.failure||evidence.closeError?1:0);`;

test('Vite readiness then callable native hook and SSR transform',async({page},info)=>{
  test.skip(!['experimental-fibers-simd','experimental-fibers-simd-lazy'].includes(manifest.buildProfile),'Requires SIMD fiber package')
  test.setTimeout(60000)
  const nativeApp=mkdtempSync(join(tmpdir(),'vite-callable-native-'))
  const native=spawnSync(process.execPath,['--input-type=module','-e',source.replace("process.cwd()+'/callable-app'",JSON.stringify(nativeApp))],{cwd:resolve('fixtures/vite-rolldown-wasm'),env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:nativeBinding},encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-vite8-callable.json')
  await writeFile(nativePath,JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message,binding:nativeBinding},null,2));await info.attach('native-vite8-callable.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout.trim().split('\n').at(-1))
  expect(expected.failure).toBeUndefined();expect(expected.results).toHaveLength(1);expect(expected.transformed).toContain('42')
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
  const path=info.outputPath('guest-vite8-callable.json');await writeFile(path,JSON.stringify({root,policy,guestBinding,preparation,expected,observed},null,2));await info.attach('guest-vite8-callable.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
  expect(JSON.parse(observed.result.stdout.trim().split('\n').at(-1))).toEqual(expected)
  expect(observed.closeError).toBeUndefined()
})

