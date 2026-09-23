import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync,mkdtempSync,writeFileSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,join,sep,extname} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'
const sdkRoot=realpathSync(process.env.SDK_OUTPUT),fixture=resolve('fixtures/vite-rolldown-wasm')
const config=version=>`export default {define:{'import.meta.env.VITE_MESSAGE':JSON.stringify('${version}')},plugins:[{name:'watch-evidence',configureServer(){console.log('CONFIG_READY:${version}')}}]}`
const project={'package.json':'{"type":"module"}','index.html':'<script type="module" src="/main.ts"></script>','main.ts':'export const message: string = import.meta.env.VITE_MESSAGE;','vite.config.ts':config('first')}
const policy={experimentalFibers:true,maxBytes:128*1024*1024,workerMaxBytes:64*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let owner,url,snapshot
test.beforeAll(async()=>{
 snapshot=JSON.stringify(await collectInstalledClosure(fixture,['vite','@rolldown/binding-wasm32-wasi']))
 owner=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname
 if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
 if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
 try{if(!path.startsWith('/sdk/'))throw Error();const file=realpathSync(resolve(sdkRoot,decodeURIComponent(path.slice(5))));if(!file.startsWith(sdkRoot+sep))throw Error();res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}})
 await new Promise(done=>owner.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${owner.address().port}`
})
test.afterAll(async()=>{if(owner)await new Promise(done=>owner.close(done))})
function source(importPath,root){return `import {createServer} from ${JSON.stringify(importPath)};import fs from 'node:fs';import http from 'node:http';
const evidence={stages:[],transientErrors:[]};let server;
const request=()=>new Promise((resolve,reject)=>{const req=http.get('http://127.0.0.1:8521/main.ts',res=>{let text='';res.on('data',data=>text+=data);res.on('error',reject);res.on('end',()=>res.statusCode===200?resolve(text):reject(Error('HTTP '+res.statusCode)))});req.on('error',reject)});
try{server=await createServer({root:${JSON.stringify(root)},logLevel:'silent',server:{host:'127.0.0.1',port:8521,strictPort:true}});await server.listen();evidence.stages.push('listening');evidence.before=await request();
fs.writeFileSync(${JSON.stringify(root+'/vite.config.ts')},${JSON.stringify(config('second'))});evidence.stages.push('config-edited');
const deadline=Date.now()+10000;while(Date.now()<deadline){try{evidence.after=await request();if(evidence.after.includes('"second"'))break}catch(error){evidence.transientErrors.push(error.message)}await new Promise(r=>setTimeout(r,25))}
if(!evidence.after?.includes('"second"'))throw Error('Config watcher did not apply second define');evidence.stages.push('restarted-output');
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}finally{if(server)try{await server.close();evidence.closed=true}catch(error){evidence.closeError=error.message}}
console.log('RESULT:'+JSON.stringify(evidence));process.exit(evidence.failure||evidence.closeError?1:0);`}
test('Vite8 config watcher restarts the live server and changes define output',async({page},info)=>{
 const nativeRoot=mkdtempSync(join(tmpdir(),'vite8-config-watch-'));for(const [name,text] of Object.entries(project))writeFileSync(join(nativeRoot,name),text)
 const native=spawnSync(process.execPath,['--input-type=module','-e',source(pathToFileURL(resolve(fixture,'node_modules/vite/dist/node/index.js')).href,nativeRoot)],{encoding:'utf8',timeout:15000,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:resolve(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')}})
 const nativePath=info.outputPath('native-config-watch.json');await writeFile(nativePath,JSON.stringify({status:native.status,error:native.error?.message,stdout:native.stdout,stderr:native.stderr},null,2));await info.attach('native-config-watch.json',{path:nativePath,contentType:'application/json'})
 expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
 await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
 const observed=await page.evaluate(async({project,source,policy})=>{let kernel;const evidence={};try{
 const closure=await fetch('/fixture.json').then(r=>r.json()),files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
 for(const [name,text] of Object.entries(project))files['/project/app/'+name]=text
 files['/project/main.mjs']=source;kernel=new window.sdk.WorkerKernel(files,policy)
 evidence.result=await kernel.runModule('/project/main.mjs',{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:'/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'},guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000})
 }catch(error){evidence.failure={name:error.name,message:error.message}}finally{if(kernel)try{kernel.close()}catch(error){evidence.closeError=error.message}}return evidence},{project,source:source('vite','/project/app'),policy})
 const path=info.outputPath('guest-config-watch.json');await writeFile(path,JSON.stringify({sdkRoot,policy,scope:'Real config file watcher and automatic restart. No manual restart or dependency prebundle claim.',observed},null,2));await info.attach('guest-config-watch.json',{path,contentType:'application/json'})
 expect(observed.failure,JSON.stringify(observed)).toBeUndefined();expect(observed.closeError).toBeUndefined();expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
 for(const stdout of [native.stdout,observed.result.stdout]){expect(stdout).toContain('CONFIG_READY:first');expect(stdout).toContain('CONFIG_READY:second');const result=JSON.parse(stdout.split('\n').find(line=>line.startsWith('RESULT:')).slice(7));expect(result.before).toContain('"first"');expect(result.after).toContain('"second"');expect(result.closed).toBe(true);expect(result.failure).toBeUndefined()}
})
