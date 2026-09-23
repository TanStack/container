import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT)
const growthReservation=process.env.WASM_GROWTH_RESERVATION==='1'
const rolldownMaxBytes=Number(process.env.ROLLDOWN_HEAP_MIB??256)*1024*1024
if(!Number.isSafeInteger(rolldownMaxBytes)||rolldownMaxBytes<16*1024*1024||rolldownMaxBytes>256*1024*1024)throw Error('Invalid bounded Rolldown heap fixture setting')
const experimentalFibers=['experimental-fibers','experimental-fibers-simd','experimental-fibers-simd-lazy'].includes(JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8')).buildProfile)
const packages=['@rolldown/binding-wasm32-wasi','@astrojs/compiler-binding-wasm32-wasi']
const fixtureRoot=name=>resolve(name.startsWith('@astrojs/')?'fixtures/compiler-wasi-astro':'fixtures/compiler-wasi')
let server,url
const fixtures=new Map()
test.beforeAll(async()=>{
  for(const [index,name] of packages.entries())fixtures.set('/fixture-'+index+'.json',JSON.stringify(await collectInstalledClosure(fixtureRoot(name),[name])))
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(fixtures.has(path)){res.setHeader('content-type','application/json');res.end(fixtures.get(path));return}
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

const rolldownBundleSource=`(async()=>{
const evidence={chunks:[],cleanup:[]};let binding,bundler;
try{
 binding=require('@rolldown/binding-wasm32-wasi');binding.startAsyncRuntime();bundler=new binding.BindingBundler();
 const modules={'virtual:main':"import { answer } from 'virtual:dep'; export const result = answer + 1;",'virtual:dep':'export const answer = 41; export const unused = 999;'};
 const output=await bundler.generate({inputOptions:{input:[{name:'main',import:'virtual:main'}],plugins:[{name:'two-module-fixture',hookUsage:10,resolveId:(_ctx,id)=>id in modules?{id}:null,load:(_ctx,id)=>id in modules?{code:modules[id],moduleType:'js'}:null}],cwd:process.cwd(),logLevel:binding.BindingLogLevel.Silent,onLog:()=>{},platform:'neutral'},outputOptions:{plugins:[],format:'es',entryFileNames:'bundle.js'}});
 if(output.isBindingErrors)throw Error(JSON.stringify(output.errors));
 evidence.chunks=output.chunks.map(chunk=>({code:chunk.getCode(),fileName:chunk.getFileName(),exports:chunk.getExports(),imports:chunk.getImports(),moduleIds:chunk.getModuleIds()}));
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
 if(bundler)try{await bundler.close()}catch(error){evidence.cleanup.push({stage:'close',message:error.message,stack:error.stack})}
 if(binding)try{binding.shutdownAsyncRuntime()}catch(error){evidence.cleanup.push({stage:'shutdown',message:error.message,stack:error.stack})}
}
return evidence;
})().then(evidence=>{console.log(JSON.stringify(evidence));process.exit(evidence.failure||evidence.cleanup.length?1:0)},error=>{console.error(error.stack);process.exit(1)});`

test('packaged Rolldown bundles two virtual modules with native output parity',async({page},info)=>{
  test.skip(!experimentalFibers,'Requires experimental-fibers package')
  const native=spawnSync(process.execPath,['-e',rolldownBundleSource],{cwd:fixtureRoot('@rolldown/binding-wasm32-wasi'),encoding:'utf8',timeout:15000})
  const nativeEvidencePath=info.outputPath('native-rolldown-bundle.json')
  await writeFile(nativeEvidencePath,JSON.stringify({node:process.version,status:native.status,signal:native.signal,error:native.error?.message,stdout:native.stdout,stderr:native.stderr},null,2))
  await info.attach('native-rolldown-bundle.json',{path:nativeEvidencePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.error?.message||native.stdout).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected.failure).toBeUndefined();expect(expected.cleanup).toEqual([])
  expect(expected.chunks).toHaveLength(1)
  expect(expected.chunks[0]).toMatchObject({fileName:'bundle.js',exports:['result'],imports:[]})
  expect([...expected.chunks[0].moduleIds].sort()).toEqual(['virtual:dep','virtual:main'])
  expect(expected.chunks[0].code).not.toContain('999')
  const executed=await import('data:text/javascript;base64,'+Buffer.from(expected.chunks[0].code).toString('base64'))
  expect(executed.result).toBe(42)
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const execution=await page.evaluate(async({source,growthReservation,rolldownMaxBytes})=>{
    const evidence={result:null,error:null,cleanup:[],output:[]};let kernel
    try{
    const snapshot=await fetch('/fixture-0.json').then(response=>response.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
    files['/project/main.cjs']=source
    kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation},maxBytes:rolldownMaxBytes,timeoutMs:15000,workspace:{maxBytes:64*1024*1024}})
    evidence.result=await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,timeoutMs:15000,maxBytes:rolldownMaxBytes,onOutput:(level,text)=>evidence.output.push({level,text})})
    }catch(error){evidence.error={name:error.name,message:error.message,stack:error.stack}}
    finally{if(kernel)try{kernel.close()}catch(error){evidence.cleanup.push({name:error.name,message:error.message,stack:error.stack})}}
    return evidence
  },{source:rolldownBundleSource,growthReservation,rolldownMaxBytes})
  const guestEvidencePath=info.outputPath('packaged-rolldown-bundle.json')
  await writeFile(guestEvidencePath,JSON.stringify({scope:'Actual unchanged Rolldown binding generates a two-module bundle',growthReservation,rolldownMaxBytes,expected,...execution},null,2))
  await info.attach('packaged-rolldown-bundle.json',{path:guestEvidencePath,contentType:'application/json'})
  expect(execution.error,JSON.stringify(execution)).toBeNull()
  expect(execution.cleanup).toEqual([])
  const result=execution.result
  expect(result.exitCode,result.stderr||result.stdout).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(expected)
})

test('packaged Astro parses and compiles a component with Node output parity',async({page},info)=>{
  test.skip(!experimentalFibers,'Requires experimental-fibers package')
  const component=['---','const name = "World";','---','<h1>Hello {name}!</h1>'].join('\n')
  const source=`const binding=require('@astrojs/compiler-binding-wasm32-wasi');
const source=${JSON.stringify(component)};
const parsed=binding.parseAstroSync(source);
const compiled=binding.compileAstroSync(source,{filename:'Component.astro',sourcemap:'external'});
console.log(JSON.stringify({parsed,compiled}));`
  const native=spawnSync(process.execPath,['-e',source+'process.exit(0)'],{cwd:fixtureRoot('@astrojs/compiler-binding-wasm32-wasi'),encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(JSON.parse(expected.parsed.ast).type).toBe('AstroRoot')
  expect(expected.parsed.diagnostics).toEqual([])
  expect(expected.compiled.diagnostics).toEqual([])
  expect(JSON.parse(expected.compiled.map).sourcesContent).toEqual([component])
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const result=await page.evaluate(async source=>{
    const snapshot=await fetch('/fixture-1.json').then(response=>response.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
    files['/project/main.cjs']=source
    const kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,sharedMemoryPerEngine:{maxBytes:512*1024*1024},maxBytes:256*1024*1024,timeoutMs:15000,workspace:{maxBytes:64*1024*1024}})
    try{return await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,timeoutMs:15000,maxBytes:256*1024*1024})}
    finally{kernel.close()}
  },source)
  await info.attach('astro-compile.json',{body:JSON.stringify({component,expected,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(expected)
})

for(const name of packages)test(`packaged compiler WASI binding loads: ${name}`,async({page},info)=>{
  const requestedPolicy={maxBytes:256*1024*1024,timeoutMs:15000,...(experimentalFibers?{sharedMemoryPerEngine:{maxBytes:(name.startsWith('@astrojs/')?512:1280)*1024*1024,growthReservation}}:{})}
  const source=`const binding=require(${JSON.stringify(name)});console.log(JSON.stringify({exports:Object.keys(binding).sort()}));process.exit(0)`
  const native=spawnSync(process.execPath,['-e',source],{cwd:fixtureRoot(name),encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-binding-result.json')
  await writeFile(nativePath,JSON.stringify({name,node:process.version,status:native.status,signal:native.signal,error:native.error?.message,stdout:native.stdout,stderr:native.stderr},null,2))
  await info.attach('native-binding-result.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,'Native binding control failed: '+native.stderr).toBe(0)
  await page.goto(url)
  await page.waitForFunction(()=>Boolean(window.sdk))
  const result=await page.evaluate(async({name,index,experimentalFibers,requestedPolicy})=>{
    const snapshot=await fetch('/fixture-'+index+'.json').then(response=>response.json())
    const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
    files['/project/main.cjs']=`const binding=require(${JSON.stringify(name)});console.log(JSON.stringify({exports:Object.keys(binding).sort()}))`
    const kernel=new window.sdk.WorkerKernel(files,{cooperative:!experimentalFibers,experimentalFibers,...requestedPolicy,workspace:{maxBytes:64*1024*1024}})
    try{return await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,timeoutMs:15000,maxBytes:256*1024*1024})}
    finally{kernel.close()}
  },{name,index:packages.indexOf(name),experimentalFibers,requestedPolicy})
  const path=info.outputPath('wasi-binding-result.json')
  await writeFile(path,JSON.stringify({name,experimentalFibers,requestedPolicy,scope:'Actual unchanged binding load and exports, not a compilation workload',result},null,2))
  await info.attach('wasi-binding-result.json',{path,contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(native.stdout))
})
