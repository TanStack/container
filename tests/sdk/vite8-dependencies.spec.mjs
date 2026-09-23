import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const sdkRoot=realpathSync(process.env.SDK_OUTPUT),fixture=resolve('fixtures/vite-rolldown-wasm')
const html='<script type="module" src="/main.ts"></script>',main='import colors from "picocolors";export const value=colors.green("dependency-ready")'
const policy={experimentalFibers:true,maxBytes:128*1024*1024,workerMaxBytes:64*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let owner,url,snapshot
test.beforeAll(async()=>{
 snapshot=JSON.stringify(await collectInstalledClosure(fixture,['vite','@rolldown/binding-wasm32-wasi','picocolors']))
 owner=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname
 if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
 if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
 try{if(!path.startsWith('/sdk/'))throw Error();const file=realpathSync(resolve(sdkRoot,decodeURIComponent(path.slice(5))));if(!file.startsWith(sdkRoot+sep))throw Error();res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))}catch{res.statusCode=404;res.end()}})
 await new Promise(done=>owner.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${owner.address().port}`
})
test.afterAll(async()=>{if(owner)await new Promise(done=>owner.close(done))})

// Execute the served optimizer module, including its relative helper chunks.
// This only relocates import URLs, it does not transform the dependency code.
async function dependencyEvidence(request){
 const transformed=await request('/main.ts'),dependencyPath=/["']([^"']*\/\.vite\/deps\/picocolors\.js[^"']*)["']/.exec(transformed)?.[1]
 if(!dependencyPath)throw Error('Missing optimizer dependency URL: '+transformed)
 const modules=[],pending=new Map()
 async function relocate(path){if(pending.has(path))return pending.get(path);const code=await request(path);modules.push({path,code});let output=code
 const imports=[...code.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)]
 for(const match of imports){const target=new URL(match[1],'http://localhost'+path);const replacement=await relocate(target.pathname+target.search);output=output.split(match[1]).join(replacement)}
 const result='data:text/javascript;charset=utf-8,'+encodeURIComponent(output);pending.set(path,result);return result}
 const loaded=await import(await relocate(dependencyPath));return {transformed,dependencyPath,modules,result:{green:loaded.default.green('dependency-ready'),colorSupported:loaded.default.isColorSupported,createColors:typeof loaded.default.createColors}}
}
test('Vite8 prebundles installed CommonJS dependency and serves executable ESM',async({page},info)=>{
 test.setTimeout(60000)
 const nativeSource=`import {mkdtemp,writeFile,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';const root=await mkdtemp(join(tmpdir(),'vite8-dependency-'));await symlink(${JSON.stringify(resolve(fixture,'node_modules'))},join(root,'node_modules'));await writeFile(join(root,'index.html'),${JSON.stringify(html)});await writeFile(join(root,'main.ts'),${JSON.stringify(main)});const {createServer}=await import(${JSON.stringify(pathToFileURL(resolve(fixture,'node_modules/vite/dist/node/index.js')).href)});let server;const evidence={};try{server=await createServer({root,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();const base='http://127.0.0.1:'+server.httpServer.address().port;Object.assign(evidence,await (${dependencyEvidence.toString()})(async path=>{const r=await fetch(base+path);if(r.status!==200)throw Error('HTTP '+r.status+' '+path);return r.text()}))}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}finally{if(server)await server.close()}console.log(JSON.stringify(evidence));process.exit(evidence.failure?1:0);`
 const native=spawnSync(process.execPath,['--input-type=module','-e',nativeSource],{encoding:'utf8',timeout:15000,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:resolve(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')}})
 const nativePath=info.outputPath('native-vite8-dependencies.json');await writeFile(nativePath,JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message},null,2));await info.attach('native-vite8-dependencies.json',{path:nativePath,contentType:'application/json'});expect(native.status,native.stderr||native.stdout).toBe(0)
 const expected=JSON.parse(native.stdout.trim().split('\n').at(-1));await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
 const observed=await page.evaluate(async({policy,html,main,evaluateSource})=>{
 const evidence={output:'',cleanup:[],resources:[]};let kernel,child,timer,drain
 const captureResources=async phase=>{if(kernel)try{evidence.resources.push({phase,snapshot:await kernel.resources()})}catch(error){evidence.resources.push({phase,error:error.message})}}
 try{const closure=await fetch('/fixture.json').then(r=>r.json()),files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]));files['/project/app/index.html']=html;files['/project/app/main.ts']=main
 files['/project/server.mjs']=`import {createServer} from 'vite';const server=await createServer({root:'/project/app',configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:8521,strictPort:true}});await server.listen();console.log('VITE_READY');`
 kernel=new window.sdk.WorkerKernel(files,policy);timer=setTimeout(()=>kernel.close(new Error('Dependency workflow deadline')),15000)
 child=await kernel.spawn('node',['/project/server.mjs'],{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:'/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'},lifetime:'session',guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000})
 for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')evidence.output+=new TextDecoder().decode(event.bytes);if(evidence.output.includes('VITE_READY'))break;if(!event||event.type==='exit')throw Error('Exited before ready: '+evidence.output)}
 drain=(async()=>{try{for(;;){const event=await child.next();if(!event)break;if(event.type==='stdout'||event.type==='stderr'){const text=new TextDecoder().decode(event.bytes);evidence.output=(evidence.output+text).slice(-65536)}if(event.type==='exit'){evidence.exit=event;break}}}catch(error){evidence.drainError={name:error.name,message:error.message}}})()
 await captureResources('ready')
 const http=new window.sdk.WorkerHTTP(kernel,8521);Object.assign(evidence,await (0,eval)('('+evaluateSource+')')(async path=>{await captureResources('before-request:'+path);const response=await http.fetch(new Request('http://localhost:8521'+path));await captureResources('response:'+path);if(response.status!==200)evidence.httpFailure={path,status:response.status};let body;try{body=await response.text()}catch(error){evidence.bodyError={path,status:response.status,name:error.name,message:error.message};throw error}if(response.status!==200){evidence.httpFailure.body=body;throw Error('HTTP '+response.status+' '+path)}return body}))
 }catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack};await captureResources('failure')}finally{clearTimeout(timer);for(const [name,dispose] of [['process',child&&(()=>child.dispose())],['kernel',kernel&&(()=>kernel.close())]])if(dispose)try{await dispose();evidence.cleanup.push(name);if(name==='process')await captureResources('after-process-dispose')}catch(error){evidence.cleanup.push({name,error:error.message})}}return evidence
 },{policy,html,main,evaluateSource:dependencyEvidence.toString()})
 const path=info.outputPath('guest-vite8-dependencies.json');await writeFile(path,JSON.stringify({sdkRoot,policy,scope:'Default optimizer, installed picocolors 1.1.1 CommonJS browser entry, explicit LightningCSS WASM dependency profile. Host process disposal, not graceful Vite close.',expected,observed},null,2));await info.attach('guest-vite8-dependencies.json',{path,contentType:'application/json'})
 expect(observed.failure,JSON.stringify(observed)).toBeUndefined();expect(observed.cleanup).toEqual(['process','kernel']);expect(observed.result).toEqual(expected.result);expect(observed.result).toEqual({green:'dependency-ready',colorSupported:false,createColors:'function'});expect(observed.modules.length).toBeGreaterThan(0);expect(observed.dependencyPath).toContain('/.vite/deps/picocolors.js')
})
