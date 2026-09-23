import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync,mkdtempSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname,join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
const diagnostics=process.env.START_TRANSFORM_DIAGNOSTICS==='1'
const configOnly=process.env.START_CONFIG_ONLY==='1'
const pluginsOnly=process.env.START_PLUGINS_ONLY==='1'
if(configOnly&&pluginsOnly)throw Error('Select one Start diagnostic at a time')
const guestBinding='/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'
const nativeBinding=resolve('fixtures/start-vite8-wasm/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
const policy={experimentalFibers:true,maxBytes:128*1024*1024,workerMaxBytes:64*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:128*1024*1024}}
let server,url,fixtures,preparation
test.beforeAll(async()=>{
  const publicPackage=await collectInstalledClosure(resolve('fixtures/start-vite8-wasm'),['vite','@tanstack/react-start','@tanstack/react-router','@vitejs/plugin-react','react','react-dom'])
  const wasiPackage=await collectInstalledClosure(resolve('fixtures/start-vite8-wasm'),['@rolldown/binding-wasm32-wasi'])
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

const app=Object.fromEntries(['vite.config.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/about.tsx'].map(name=>[name,readFileSync('fixtures/start-basic/'+name,'utf8')]));
const source=pluginsOnly?`const evidence={stages:[]};const phase=name=>{evidence.stages.push(name);console.log('PHASE:'+name)};
try{phase('before-import');await import('vite');phase('after-import');
const {tanstackStart}=await import('@tanstack/react-start/plugin/vite');phase('start-imported');
const {default:react}=await import('@vitejs/plugin-react');phase('react-imported');
const startPlugins=tanstackStart();phase('start-created');const reactPlugins=react();phase('react-created');
evidence.plugins=[startPlugins,reactPlugins].flat(Infinity).filter(Boolean).map(plugin=>plugin.name);evidence.base='/';
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}console.log(JSON.stringify(evidence));process.exit(evidence.failure?1:0);`:
configOnly?`const evidence={stages:[]};const phase=name=>{evidence.stages.push(name);console.log('PHASE:'+name)};
try{phase('before-import');const {loadConfigFromFile}=await import('vite');phase('after-import');const root=process.cwd()+'/callable-app';
const loaded=await loadConfigFromFile({command:'serve',mode:'development'},undefined,root,'silent');phase('config-loaded');
if(!loaded)throw Error('Config not loaded');evidence.plugins=loaded.config.plugins.flat(Infinity).filter(Boolean).map(plugin=>plugin.name);evidence.base=loaded.config.base;
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}console.log(JSON.stringify(evidence));process.exit(evidence.failure?1:0);`:
`const evidence={stages:[]};let server;const phase=name=>{evidence.stages.push(name);console.log('PHASE:'+name)};
const diagnosticPlugins=${diagnostics?`[{name:'start-timing-observer',enforce:'pre',config(){phase('config-hook')},configResolved(){phase('config-resolved')},configureServer(){phase('configure-server');return ()=>{phase('configure-server-post')}}}]`:'[]'};
try{phase('before-import');const {createServer}=await import('vite');phase('after-import');const root=process.cwd()+'/callable-app';server=await createServer({root,plugins:diagnosticPlugins,logLevel:'silent',server:{host:'127.0.0.1',port:0}});phase('server-created');await server.listen();phase('ready');
phase('before-ssr-transform');const transformed=await server.environments.ssr.transformRequest(TARGET_MODULE);evidence.transformed=transformed.code;phase('after-ssr-transform');
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}finally{if(server)try{await server.close();phase('closed')}catch(error){evidence.closeError=error.message}}console.log(JSON.stringify(evidence));process.exit(evidence.failure||evidence.closeError?1:0);`;

test(pluginsOnly?'Start plugin imports diagnostic, not config loading':configOnly?'Start config loading diagnostic, not server readiness':'Start readiness then direct server module SSR transform',async({page},info)=>{
  test.skip(!['experimental-fibers-simd','experimental-fibers-simd-lazy','experimental-fibers-simd-lazy-initializers','experimental-fibers-simd-lazy-initializers-o2','experimental-fibers-simd-lazy-initializers-o2-assignments'].includes(manifest.buildProfile),'Requires SIMD fiber package')
  test.setTimeout(60000)
  const nativeApp=mkdtempSync(join(tmpdir(),'vite-callable-native-'))
  symlinkSync(resolve('fixtures/start-vite8-wasm/node_modules'),join(nativeApp,'node_modules'),'dir')
  writeFileSync(join(nativeApp,'package.json'),'{"type":"module"}')
  for(const [name,content] of Object.entries(app)){mkdirSync(dirname(join(nativeApp,name)),{recursive:true});writeFileSync(join(nativeApp,name),content)}
  const native=spawnSync(process.execPath,['--input-type=module','-e',source.replace("process.cwd()+'/callable-app'",JSON.stringify(nativeApp)).replace("TARGET_MODULE",JSON.stringify("/@fs/"+resolve("fixtures/start-vite8-wasm/node_modules/@tanstack/react-start/dist/esm/server.js")))],{cwd:resolve('fixtures/start-vite8-wasm'),env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:nativeBinding},encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-start-vite8-transform.json')
  await writeFile(nativePath,JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message,binding:nativeBinding},null,2));await info.attach('native-start-vite8-transform.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout.trim().split('\n').at(-1))
  expect(expected.failure).toBeUndefined()
  if(configOnly||pluginsOnly){expect(expected.plugins.length).toBeGreaterThan(0);expect(expected.base).toBe('/')}
  else expect(expected.transformed).toContain('@tanstack/react-start-server')
  const browserDiagnostics=[]
  if(diagnostics){
    page.on('console',message=>{if(browserDiagnostics.length<100)browserDiagnostics.push({kind:'console',level:message.type(),text:message.text(),location:message.location()})})
    page.on('pageerror',error=>{if(browserDiagnostics.length<100)browserDiagnostics.push({kind:'pageerror',name:error.name,message:error.message,stack:error.stack})})
  }
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async({source,policy,guestBinding,app,diagnostics})=>{
    const snapshot=await fetch('/fixture.json').then(r=>r.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
    for(const [name,content] of Object.entries(app))files['/project/callable-app/'+name]=content
    files['/project/package.json']='{"type":"module"}'
    files['/project/main.mjs']=source.replace('TARGET_MODULE',JSON.stringify('/@fs/project/node_modules/@tanstack/react-start/dist/esm/server.js'))
    const kernel=new window.sdk.WorkerKernel(files,policy);const output=[];let result,error,closeError,jobProfile
    const observationStart=performance.now()
    try{result=await kernel.runModule('/project/main.mjs',{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:guestBinding},guestWasm:true,webAPIs:true,diagnostics,maxBytes:policy.maxBytes,timeoutMs:15000,onOutput:(level,text)=>output.push({level,text,receivedAfterMs:performance.now()-observationStart})})}catch(e){error={name:e.name,message:e.message}}
    finally{jobProfile=kernel.jobProfile.slice(0,100);try{kernel.close()}catch(e){closeError={message:e.message}}}
    return {result,error,closeError,output,diagnostics,jobProfile}
  },{source,policy,guestBinding,app,diagnostics})
  const path=info.outputPath('guest-start-vite8-transform.json');await writeFile(path,JSON.stringify({root,policy,guestBinding,preparation,expected,observed,browserDiagnostics},null,2));await info.attach('guest-start-vite8-transform.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
  const actual=JSON.parse(observed.result.stdout.trim().split('\n').at(-1));expect(actual.stages).toEqual(expected.stages)
  if(configOnly||pluginsOnly)expect(actual).toEqual(expected)
  else expect(actual.transformed).toBe(expected.transformed.split(resolve('fixtures/start-vite8-wasm')).join('/project'))
  expect(observed.closeError).toBeUndefined()
})
