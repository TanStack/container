import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync,mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,join,sep,extname} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const sdkRoot=realpathSync(process.env.SDK_OUTPUT),dependencyRoot=resolve('fixtures/vite-rolldown-wasm')
const policy={experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
const project={
 'package.json':'{"type":"module"}',
 'index.html':'<div id="app"></div><script type="module" src="/main.ts"></script>',
 'main.ts':'import "./style.css";document.querySelector("#app")!.textContent="CONFIG_MARKER:first"',
 'style.css':'#app { color: rgb(10, 20, 30); }',
 'plugin.ts':'export default function localPlugin(){return {name:"local-config-plugin",transform(code: string,id: string){if(id.endsWith("/main.ts"))return code.replace("CONFIG_MARKER", "plugin-transformed")}}}',
 'vite.config.ts':'import {defineConfig} from "vite";import localPlugin from "./plugin";export default defineConfig({plugins:[localPlugin()],build:{write:false,sourcemap:true}})',
}
let server,url,fixture,preparation
test.beforeAll(async()=>{
 const vite=await collectInstalledClosure(dependencyRoot,['vite']),wasi=await collectInstalledClosure(dependencyRoot,['@rolldown/binding-wasm32-wasi'])
 const overlaps=Object.keys(vite.files).filter(path=>Object.hasOwn(wasi.files,path))
 for(const path of overlaps)if(vite.files[path].base64!==wasi.files[path].base64)throw Error('Conflicting closure file: '+path)
 preparation={vite:vite.preparation,wasi:wasi.preparation,identicalOverlaps:overlaps};fixture=JSON.stringify({files:{...vite.files,...wasi.files}})
 server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname
  if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
  if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(fixture);return}
  try{if(!path.startsWith('/sdk/'))throw Error();const file=realpathSync(resolve(sdkRoot,decodeURIComponent(path.slice(5))));if(!file.startsWith(sdkRoot+sep))throw Error();res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}
 });await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})
function source(importPath,root){return `const evidence={stages:[],builds:[]};const phase=value=>{evidence.stages.push(value);console.log('VITE_PHASE:'+value)};try{
 phase('before-import');const {build}=await import(${JSON.stringify(importPath)});const fs=await import('node:fs');phase('imported');
 for(const version of ['first','second']){if(version==='second')fs.writeFileSync(${JSON.stringify(root+'/main.ts')},fs.readFileSync(${JSON.stringify(root+'/main.ts')},'utf8').replace(':first',':second'));phase('before-'+version);const result=await build({root:${JSON.stringify(root)},logLevel:'silent'});phase('built-'+version);evidence.builds.push((Array.isArray(result)?result:[result]).flatMap(item=>item.output).map(item=>({type:item.type,fileName:item.fileName,content:item.type==='chunk'?item.code:typeof item.source==='string'?item.source:Buffer.from(item.source).toString('utf8')})))}
 }catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack,cause:error.cause?.message};phase('failed')}console.log(JSON.stringify(evidence));process.exit(evidence.failure?1:0);`}
function verify(value){expect(value.builds).toHaveLength(2);for(const [i,outputs] of value.builds.entries()){expect(outputs.some(item=>item.type==='chunk'&&item.content.includes('plugin-transformed:'+['first','second'][i]))).toBe(true);expect(outputs.some(item=>item.fileName.endsWith('.css'))).toBe(true);expect(outputs.some(item=>item.fileName.endsWith('.map')&&JSON.parse(item.content).version===3)).toBe(true)}}
const configEditProject={...project,
 'main.ts':'import "./style.css";document.querySelector("#app")!.textContent=__CONFIG_MESSAGE__',
 'vite.config.ts':'import {defineConfig} from "vite";export default defineConfig({define:{__CONFIG_MESSAGE__:JSON.stringify("plugin-transformed:first")},build:{write:false,sourcemap:true}})',
}
function configEditSource(importPath,root){
 // Same build operation, but only the config file changes between invocations.
 return source(importPath,root).replaceAll(JSON.stringify(root+'/main.ts'),JSON.stringify(root+'/vite.config.ts'))
}
test('Vite re-reads an edited TypeScript config between build calls',async({page},info)=>{
 test.setTimeout(60000)
 const root=mkdtempSync(join(tmpdir(),'vite-config-edit-native-')),nativeRoot=join(root,'app');mkdirSync(nativeRoot)
 symlinkSync(join(dependencyRoot,'node_modules'),join(root,'node_modules'),'dir')
 for(const [name,content] of Object.entries(configEditProject))writeFileSync(join(nativeRoot,name),content)
 const native=spawnSync(process.execPath,['--input-type=module','-e',configEditSource(pathToFileURL(join(dependencyRoot,'node_modules/vite/dist/node/index.js')).href,nativeRoot)],{encoding:'utf8',timeout:15000,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:join(dependencyRoot,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')}})
 const nativePath=info.outputPath('native-vite-config-edit.json');await writeFile(nativePath,JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message},null,2));await info.attach('native-vite-config-edit.json',{path:nativePath,contentType:'application/json'})
 expect(native.status,native.stderr||native.stdout).toBe(0);const expected=JSON.parse(native.stdout.trim().split('\n').at(-1));verify(expected)
 await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
 const observed=await page.evaluate(async({project,source,policy})=>{
  const closure=await fetch('/fixture.json').then(r=>r.json()),files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
  for(const [name,content] of Object.entries(project))files['/project/app/'+name]=content
  files['/project/main.mjs']=source;let kernel,result,error,closeError;const output=[]
  try{kernel=new window.sdk.WorkerKernel(files,policy);result=await kernel.runModule('/project/main.mjs',{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:'/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'},guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000,onOutput:(level,text)=>output.push({level,text})})}catch(e){error={name:e.name,message:e.message}}finally{if(kernel)try{kernel.close()}catch(e){closeError=e.message}}
  return {result,error,closeError,output}
 },{project:configEditProject,source:configEditSource('vite','/project/app'),policy})
 const path=info.outputPath('guest-vite-config-edit.json');await writeFile(path,JSON.stringify({sdkRoot,policy,preparation,expected,observed},null,2));await info.attach('guest-vite-config-edit.json',{path,contentType:'application/json'})
 expect(observed.error,JSON.stringify(observed)).toBeUndefined();expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
 const actual=JSON.parse(observed.result.stdout.trim().split('\n').at(-1));verify(actual)
 const normalize=value=>JSON.parse(JSON.stringify(value).split(nativeRoot).join('$ROOT').split('/project/app').join('$ROOT'))
 expect(normalize(actual)).toEqual(normalize(expected));expect(observed.closeError).toBeUndefined()
})
test('Vite default TypeScript config loader and local plugin rebuild',async({page},info)=>{
 test.setTimeout(60000)
 const root=mkdtempSync(join(tmpdir(),'vite-config-native-'));mkdirSync(join(root,'app'));const nativeRoot=join(root,'app')
 symlinkSync(join(dependencyRoot,'node_modules'),join(root,'node_modules'),'dir')
 for(const [name,content] of Object.entries(project))writeFileSync(join(nativeRoot,name),content)
 const native=spawnSync(process.execPath,['--input-type=module','-e',source(pathToFileURL(join(dependencyRoot,'node_modules/vite/dist/node/index.js')).href,nativeRoot)],{encoding:'utf8',timeout:15000,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:join(dependencyRoot,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')}})
 const nativePath=info.outputPath('native-vite-config.json');await writeFile(nativePath,JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message},null,2));await info.attach('native-vite-config.json',{path:nativePath,contentType:'application/json'})
 expect(native.status,native.stderr||native.stdout).toBe(0);const expected=JSON.parse(native.stdout.trim().split('\n').at(-1));verify(expected)
 await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
 const observed=await page.evaluate(async({project,source,policy})=>{const closure=await fetch('/fixture.json').then(r=>r.json()),files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]));for(const [name,content] of Object.entries(project))files['/project/app/'+name]=content;files['/project/main.mjs']=source;let kernel,result,error,closeError;const output=[];try{kernel=new window.sdk.WorkerKernel(files,policy);result=await kernel.runModule('/project/main.mjs',{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:'/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'},guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000,onOutput:(level,text)=>output.push({level,text})})}catch(e){error={name:e.name,message:e.message}}finally{if(kernel)try{kernel.close()}catch(e){closeError=e.message}}return {result,error,closeError,output}}, {project,source:source('vite','/project/app'),policy})
 const path=info.outputPath('guest-vite-config.json');await writeFile(path,JSON.stringify({sdkRoot,dependencyProfile:'Explicit LightningCSS WASM alias, default config loader',policy,preparation,expected,observed},null,2));await info.attach('guest-vite-config.json',{path,contentType:'application/json'})
 expect(observed.error,JSON.stringify(observed)).toBeUndefined();expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0);const actual=JSON.parse(observed.result.stdout.trim().split('\n').at(-1));verify(actual)
 const normalize=value=>JSON.parse(JSON.stringify(value).split(nativeRoot).join('$ROOT').split('/project/app').join('$ROOT'));expect(normalize(actual)).toEqual(normalize(expected));expect(observed.closeError).toBeUndefined()
})
