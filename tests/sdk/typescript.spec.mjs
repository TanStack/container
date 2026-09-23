import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const root=realpathSync(process.env.SDK_OUTPUT),fixture=resolve('fixtures/install-sveltekit-wasm')
let server,url,snapshot
test.beforeAll(async()=>{
  snapshot=JSON.stringify(await collectInstalledClosure(fixture,['typescript']))
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

test('policy diagnostic: unchanged TypeScript version load exceeds module source admission, not compiler compatibility',async({page},info)=>{
 const source="console.log(require('typescript').version)"
 const native=spawnSync(process.execPath,['-e',source],{cwd:fixture,encoding:'utf8',timeout:15000})
 const moduleBytes=readFileSync(resolve(fixture,'node_modules/typescript/lib/typescript.js')).byteLength
 const policy={experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000,workspace:{maxBytes:64*1024*1024}}
 await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
 const observed=await page.evaluate(async({source,policy})=>{
  let kernel;const evidence={}
  try{
   const closure=await fetch('/fixture.json').then(response=>response.json())
   const files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
   files['/project/version.cjs']=source
   kernel=new window.sdk.WorkerKernel(files,policy)
   evidence.result=await kernel.runModule('/project/version.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000})
  }catch(error){evidence.error={name:error.name,message:error.message,stack:error.stack}}
  finally{if(kernel)try{kernel.close()}catch(error){evidence.cleanupError=error.message}}
  return evidence
 },{source,policy})
 const path=info.outputPath('typescript-source-admission.json')
 await writeFile(path,JSON.stringify({scope:'Policy diagnostic, not a TypeScript compiler compatibility pass',sdk:root,policy,moduleBytes,native:{status:native.status,stdout:native.stdout,stderr:native.stderr,error:native.error?.message},observed},null,2))
 await info.attach('typescript-source-admission.json',{path,contentType:'application/json'})
 expect(native.status,native.stderr).toBe(0);expect(native.stdout.trim()).toBe('5.9.3');expect(moduleBytes).toBe(9112572)
 expect(observed.error,JSON.stringify(observed)).toBeUndefined();expect(observed.cleanupError).toBeUndefined()
 expect(observed.result.exitCode).not.toBe(0);expect(observed.result.stdout).toBe('')
 expect(observed.result.stderr).toContain('Runtime module source quota exceeded: module source bytes 9112572 exceed 8388608 while loading "/project/node_modules/typescript/lib/typescript.js"')
})

for(const sample of [
  {name:'typed-function.ts',source:'type Box<T> = { value: T }; const box: Box<number> = {value: 40}; export const answer = box.value + 2;'},
  {name:'component.tsx',source:'function h(tag: string, props: unknown, ...children: unknown[]) { return {tag, props, children}; } export const view = <output answer={42}>ready</output>;'},
])test(`packaged TypeScript transpiles ${sample.name} with native output parity`,async({page},info)=>{
  // Single-file emit only, not project type checking or module resolution.
  const source=`const ts=require('typescript');const output=ts.transpileModule(${JSON.stringify(sample.source)},{fileName:${JSON.stringify(sample.name)},reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,sourceMap:true,inlineSources:true,jsx:ts.JsxEmit.React,jsxFactory:'h'}});console.log(JSON.stringify({version:ts.version,code:output.outputText,map:JSON.parse(output.sourceMapText),diagnostics:output.diagnostics.map(d=>({code:d.code,category:d.category,message:ts.flattenDiagnosticMessageText(d.messageText,'\\n')}))}));`
  const native=spawnSync(process.execPath,['-e',source],{cwd:fixture,encoding:'utf8',timeout:15000})
  const nativePath=info.outputPath('native-typescript.json')
  await writeFile(nativePath,JSON.stringify({status:native.status,error:native.error?.message,stdout:native.stdout,stderr:native.stderr},null,2))
  await info.attach('native-typescript.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout)
  expect(expected.diagnostics).toEqual([])
  expect(expected.map.sourcesContent).toEqual([sample.source]);expect(expected.map.mappings.length).toBeGreaterThan(0)
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const execution=await page.evaluate(async source=>{
    const evidence={result:null,error:null};let kernel
    try{
      const snapshot=await fetch('/fixture.json').then(r=>r.json())
      const files=Object.fromEntries(Object.entries(snapshot.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),char=>char.charCodeAt(0))]))
      files['/project/main.cjs']=source
      kernel=new window.sdk.WorkerKernel(files,{experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000,workspace:{maxBytes:64*1024*1024}})
      evidence.result=await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:128*1024*1024,timeoutMs:15000})
    }catch(error){evidence.error={name:error.name,message:error.message,stack:error.stack}}
    finally{if(kernel)kernel.close()}
    return evidence
  },source)
  const evidencePath=info.outputPath('packaged-typescript.json')
  await writeFile(evidencePath,JSON.stringify({sdk:root,sample,expected,...execution},null,2))
  await info.attach('packaged-typescript.json',{path:evidencePath,contentType:'application/json'})
  expect(execution.error,JSON.stringify(execution)).toBeNull()
  expect(execution.result.exitCode,execution.result.stderr).toBe(0)
  const actual=JSON.parse(execution.result.stdout)
  expect(actual).toEqual(expected)
  const emitted=await import('data:text/javascript;base64,'+Buffer.from(actual.code).toString('base64'))
  if(sample.name.endsWith('.tsx'))expect(emitted.view).toEqual({tag:'output',props:{answer:42},children:['ready']})
  else expect(emitted.answer).toBe(42)
})
