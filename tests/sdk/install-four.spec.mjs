import {test,expect} from '@playwright/test'
import {build} from 'esbuild'
import {readFileSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'

test('diagnostic first four pinned packages in a plain worker',async({page},info)=>{
  test.skip(info.project.name!=='webkit','WebKit install diagnostic')
  const sdk=resolve(process.env.SDK_OUTPUT)
  const project=JSON.parse(readFileSync(join(sdk,'examples/frameworks/projects.json'),'utf8')).vite
  const lockText=project['/project/package-lock.json'],lock=JSON.parse(lockText)
  // Reproduce the four observed downloads, excluding platform packages that
  // the real planner skips rather than taking the raw lockfile's first entries.
  const names=['@jridgewell/sourcemap-codec','@types/chai','@types/deep-eql','@types/estree']
  const packages=names.map(name=>{const path='node_modules/'+name,pkg=lock.packages[path];expect(pkg?.resolved).toBeTruthy();expect(pkg?.integrity).toBeTruthy();return {name,installPath:'/project/'+path,version:pkg.version,resolved:pkg.resolved,integrity:pkg.integrity}})
  expect(packages.map(pkg=>pkg.name)).toEqual(['@jridgewell/sourcemap-codec','@types/chai','@types/deep-eql','@types/estree'])
  const compiled=await build({entryPoints:['tests/sdk/install-four.worker.ts'],bundle:true,write:false,format:'esm',platform:'browser',metafile:true})
  const worker=compiled.outputFiles[0].contents
  const sourceHashes=Object.fromEntries(Object.keys(compiled.metafile.inputs).sort().map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]))
  const server=createServer((request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    if(request.url==='/worker.js'){response.setHeader('Content-Type','text/javascript');response.end(worker)}
    else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Four package install diagnostic</title>')}
  })
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done)})
  const origin='http://127.0.0.1:'+server.address().port
  try{
    await page.goto(origin)
    await page.evaluate(packages=>{
      globalThis.installDiagnostic={messages:[],ownerHeartbeats:0,done:false}
      const state=globalThis.installDiagnostic,worker=new Worker('/worker.js',{type:'module'})
      globalThis.installDiagnosticWorker=worker
      globalThis.installDiagnosticTimer=setInterval(()=>state.ownerHeartbeats++,1000)
      worker.onmessage=event=>{state.messages.push(event.data);if(state.messages.length>640)state.messages.shift();if(event.data.done){state.done=true;state.result=event.data}}
      worker.onerror=event=>{state.error=event.message;state.done=true}
      worker.postMessage({version:1,packages})
    },packages)
    await page.waitForFunction(()=>globalThis.installDiagnostic.done,undefined,{timeout:60000})
    const state=await page.evaluate(()=>globalThis.installDiagnostic)
    expect(state.error).toBeUndefined();expect(state.result?.error).toBeUndefined()
    for(const pkg of packages)expect(state.result.files).toContain(pkg.installPath+'/package.json')
  }finally{
    const state=await page.evaluate(()=>globalThis.installDiagnostic).catch(error=>({captureError:String(error)}))
    const path=info.outputPath('install-four.json')
    await writeFile(path,JSON.stringify({diagnosticOnly:true,sdk,origin,packages,lockSHA256:createHash('sha256').update(lockText).digest('hex'),sourceHashes,workerSHA256:createHash('sha256').update(worker).digest('hex'),state},null,2))
    await info.attach('install-four.json',{path,contentType:'application/json'})
    await page.evaluate(()=>{globalThis.installDiagnosticWorker?.terminate();clearInterval(globalThis.installDiagnosticTimer)}).catch(()=>{})
    await new Promise(done=>server.close(done))
  }
})
