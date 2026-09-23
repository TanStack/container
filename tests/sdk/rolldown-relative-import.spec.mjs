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
const nativeBinding=resolve('fixtures/vite-rolldown-wasm/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')
if(process.env.ROLLDOWN_WORKER_MIB!==undefined&&!['64','128'].includes(process.env.ROLLDOWN_WORKER_MIB))throw Error('ROLLDOWN_WORKER_MIB supports only 64 or 128')
const policy={experimentalFibers:true,maxBytes:128*1024*1024,workerMaxBytes:Number(process.env.ROLLDOWN_WORKER_MIB??64)*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let server,url,fixtures,preparation
test.beforeAll(async()=>{
  const publicPackage=await collectInstalledClosure(resolve('fixtures/vite-rolldown-wasm'),['rolldown'])
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


for(const mode of ['sequential','concurrent'])test('Rolldown preview relative import composition '+mode,async({page},info)=>{
  test.setTimeout(60000)
  const source=`
const evidence={mode:${JSON.stringify(mode)},stages:[],results:[]};
try{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 await fs.mkdir(os.tmpdir(),{recursive:true});
 const project=await fs.mkdtemp(path.join(os.tmpdir(),'rolldown-relative-'));
 await fs.writeFile(path.join(project,'message.ts'),'export const message: string = "first version";');
 const code="import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.onclick=()=>button.textContent=String(++count);document.querySelector('#message').textContent=message;if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);";
 const {transformSync}=await import('rolldown/utils');const {oxcRuntimePlugin,viteResolvePlugin}=await import('rolldown/experimental');
 const plugin=oxcRuntimePlugin(),handler=typeof plugin.transform==='function'?plugin.transform:plugin.transform.handler;
 const resolver=viteResolvePlugin({resolveOptions:{isBuild:false,isProduction:false,asSrc:true,preferRelative:false,root:project,scan:false,mainFields:['browser','module','jsnext:main','jsnext','main'],conditions:['module','browser','development'],externalConditions:['node'],extensions:['.mjs','.js','.mts','.ts','.jsx','.tsx','.json'],tryIndex:true,preserveSymlinks:false,tsconfigPaths:false},environmentConsumer:'client',environmentName:'client',builtins:[],external:[],noExternal:[],dedupe:[],resolveSubpathImports:()=>undefined});
 const resolveId=typeof resolver.resolveId==='function'?resolver.resolveId:resolver.resolveId.handler;
 evidence.stages.push('imported');
 const run=async i=>{evidence.stages.push('start-'+i);const filename=path.join(project,'main-'+i+'.ts');const first=await handler.call({},code,filename,{ssr:false,moduleType:'ts'});const r=transformSync(filename,first?.code??code,{lang:'ts',sourcemap:true});const resolution=await resolveId.call({},'./message',filename,{isEntry:false,kind:'import-statement'});const id=typeof resolution==='string'?resolution:resolution?.id;evidence.stages.push('done-'+i);return {code:r.code,errors:r.errors,resolved:id?path.basename(id):null}};
 if(evidence.mode==='sequential'){for(let i=0;i<3;i++)evidence.results.push(await run(i))}
 else evidence.results=await Promise.all([0,1,2].map(run));
}catch(e){evidence.failure={name:e.name,message:e.message}}

console.log(JSON.stringify(evidence));process.exit(evidence.failure?1:0);
`
  const native=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:resolve('fixtures/vite-rolldown-wasm'),env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:nativeBinding},encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native.json')
  await writeFile(nativePath,JSON.stringify({status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message},null,2));await info.attach('native.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout.trim().split('\n').at(-1));expect(expected.results).toHaveLength(3);expect(expected.results.every(r=>r.resolved==='message.ts')).toBe(true)
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async({source,policy,guestBinding})=>{
    const snapshot=await fetch('/fixture.json').then(r=>r.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
    files['/project/main.mjs']=source
    const kernel=new window.sdk.WorkerKernel(files,policy);let result,error
    try{result=await kernel.runModule('/project/main.mjs',{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:guestBinding},guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000})}catch(e){error={name:e.name,message:e.message}}
    finally{kernel.close()}
    return {result,error}
  },{source,policy,guestBinding})
  const path=info.outputPath('guest.json');await writeFile(path,JSON.stringify({root,policy,expected,observed},null,2));await info.attach('guest.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr||observed.result.stdout).toBe(0)
  const actual=JSON.parse(observed.result.stdout.trim().split('\n').at(-1))
  expect(actual.failure).toBeUndefined();expect(actual.results).toEqual(expected.results)
})
