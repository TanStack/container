import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,writeFileSync} from 'node:fs'
import {arch,release} from 'node:os'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {applyWasmMemoryPolicy} from '../../src/compiler/wasm-memory-policy'

let server:Server,url:string,provenance:Record<string,unknown>
test.beforeAll(async()=>{
  const original=readFileSync('node_modules/esbuild-wasm/esbuild.wasm')
  const prepared=applyWasmMemoryPolicy(original,1024)
  const runtime=readFileSync('node_modules/esbuild-wasm/wasm_exec.js')
  const owner=await build({entryPoints:['tests/fixtures/browser-compiler-owner.mjs'],bundle:true,format:'esm',platform:'browser',write:false})
  const worker=await build({entryPoints:['tests/fixtures/browser-compiler.worker.mjs'],bundle:true,format:'iife',platform:'browser',write:false})
  const runnerOwner=await build({entryPoints:['tests/fixtures/browser-compiler-runner-owner.mjs'],bundle:true,format:'esm',platform:'browser',write:false})
  const runnerWorker=await build({entryPoints:['src/compiler/browser-compiler.worker.ts'],bundle:true,format:'iife',platform:'browser',write:false})
  const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
  provenance={original:hash(original),prepared:hash(prepared.bytes),runtime:hash(runtime),worker:hash(worker.outputFiles[0].contents),owner:hash(owner.outputFiles[0].contents),maxPages:prepared.declaredMaxPages}
  const assets=new Map<string,[string,Uint8Array|string]>([['/',['text/html','<!doctype html><title>Compiler worker test</title>']],['/owner.js',['text/javascript',owner.outputFiles[0].contents]],['/worker.js',['text/javascript',worker.outputFiles[0].contents]],['/wasm_exec.js',['text/javascript',runtime]],['/compiler.wasm',['application/wasm',prepared.bytes]]])
  assets.set('/runner-owner.js',['text/javascript',runnerOwner.outputFiles[0].contents])
  assets.set('/runner-worker.js',['text/javascript',runnerWorker.outputFiles[0].contents])
  Object.assign(provenance,{runnerOwner:hash(runnerOwner.outputFiles[0].contents),runnerWorker:hash(runnerWorker.outputFiles[0].contents)})
  server=createServer((req,res)=>{const asset=assets.get(req.url??'');if(!asset){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':asset[0]});res.end(asset[1])})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw Error('Missing server address')
  url=`http://127.0.0.1:${address.port}`
})
test.afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()))})
test('reusable runner builds edited files and exits normally after stdin closes',async({page,browser},info)=>{
  await page.goto(url)
  const result=await page.evaluate(async()=>{const path='/runner-owner.js';return (await import(path)).runRunnerWorkflow()})
  const evidence=info.outputPath('runner-evidence.json')
  writeFileSync(evidence,JSON.stringify({browser:info.project.name,version:browser.version(),os:release(),arch:arch(),provenance,...result},null,2))
  await info.attach('runner-evidence.json',{path:evidence,contentType:'application/json'})
  expect(result.values).toEqual([42,43]);expect(result.result.code).toBe(0)
  expect(result.handshake).toBe(true);expect(result.pending).toBe(0)
  expect(result.resources).toEqual({descriptors:0,sessions:0})
})
test('browser worker builds live virtual files, then builds edited files and closes leases',async({page,browser},info)=>{
  await page.goto(url)
  const result=await page.evaluate(async()=>{
    const path='/owner.js'
    const module=await import(/* @vite-ignore */ path)
    return module.runCompilerWorkflow()
  })
  const evidence=info.outputPath('compiler-evidence.json')
  writeFileSync(evidence,JSON.stringify({browser:info.project.name,version:browser.version(),os:release(),arch:arch(),provenance,...result},null,2))
  await info.attach('compiler-evidence.json',{path:evidence,contentType:'application/json'})
  expect(result.builds.map((value:any)=>value.actual)).toEqual([42,43])
  for(const value of result.builds){expect(value.code).toBe(0);expect(value.pending).toBe(0);expect(value.memoryBytes).toBeLessThanOrEqual(64*1024*1024);expect(value.resources).toEqual({descriptors:0,sessions:0})}
})

test('one browser service worker handles two build packets around a live file edit',async({page,browser},info)=>{
  await page.goto(url)
  const result=await page.evaluate(async()=>{
    const path='/owner.js'
    const module=await import(/* @vite-ignore */ path)
    return module.runCompilerServiceWorkflow()
  })
  const evidence=info.outputPath('compiler-service-evidence.json')
  writeFileSync(evidence,JSON.stringify({browser:info.project.name,version:browser.version(),os:release(),arch:arch(),provenance,...result},null,2))
  await info.attach('compiler-service-evidence.json',{path:evidence,contentType:'application/json'})
  expect(result.builds.map((value:any)=>value.actual)).toEqual([42,43])
  expect(result.workerCount).toBe(1);expect(result.handshake).toBe(true);expect(result.pending).toBe(0)
  expect(result.resources).toEqual({descriptors:0,sessions:0})
  for(const value of result.builds){expect(value.response.errors).toEqual([]);expect(value.response.warnings).toEqual([])}
})
