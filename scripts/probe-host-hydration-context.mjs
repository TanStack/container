import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

const [rendererRoot,runnerRoot,...extra]=process.argv.slice(2)
assert.ok(rendererRoot&&runnerRoot&&!extra.length,'Usage: node scripts/probe-host-hydration-context.mjs REDACT_CHECKOUT LOCKED_RUNNER_CHECKOUT')
const renderer=resolve(rendererRoot),runner=resolve(runnerRoot)
const require=createRequire(join(runner,'package.json'))
const {build}=require('esbuild')
const {chromium,firefox,webkit}=require('@playwright/test')
const directory=mkdtempSync('/private/tmp/host-hydration-context-')
const fixture=fileURLToPath(new URL('../tests/fixtures/host-hydration-context/probe.mjs',import.meta.url))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const cases=['document-match','document-mismatch','element-match','element-mismatch','nested-match','nested-mismatch']
const bundles={}
const inputs={fixtureSHA256:hash(readFileSync(fixture)),runnerLockSHA256:hash(readFileSync(join(runner,'package-lock.json'))),
  probeSHA256:hash(readFileSync(fileURLToPath(import.meta.url))),
  rendererRevision:execFileSync('git',['-C',renderer,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  rendererVersion:JSON.parse(readFileSync(join(renderer,'packages/redact/package.json'))).version,
  react:require('react/package.json').version,reactDOM:require('react-dom/package.json').version,rendererFiles:{}}
for(const filename of ['react/index.ts','dom/client.ts','dom/index.ts','dom/features/hydration/full.ts']){
  inputs.rendererFiles[filename]=hash(readFileSync(join(renderer,'packages/redact/src',filename)))
}
for(const implementation of ['react','redact']){
  const aliases=implementation==='react'?{
    react:require.resolve('react'),'react-dom/client':require.resolve('react-dom/client'),'react-dom':require.resolve('react-dom'),
  }:{
    react:join(renderer,'packages/redact/src/react/index.ts'),
    'react-dom/client':join(renderer,'packages/redact/src/dom/client.ts'),
    'react-dom':join(renderer,'packages/redact/src/dom/index.ts'),
  }
  const output=await build({entryPoints:[fixture],bundle:true,write:false,format:'iife',platform:'browser',
    alias:aliases,define:{'process.env.NODE_ENV':'"development"'},metafile:true})
  bundles[implementation]=output.outputFiles[0].contents
  inputs[implementation+'BundleSHA256']=hash(bundles[implementation])
  inputs[implementation+'Sources']=Object.keys(output.metafile.inputs).sort().map(filename=>({
    filename,sha256:hash(readFileSync(resolve(filename))),
  }))
}
const report={scope:'Host renderer hydration/context comparison, not container or full-site acceptance',inputs,rows:[],passed:false}
const server=createServer((request,response)=>{
  if(request.url?.startsWith('/bundle/')){
    const implementation=request.url.slice('/bundle/'.length)
    if(!bundles[implementation]){response.writeHead(404);response.end();return}
    response.setHeader('Content-Type','text/javascript');response.end(bundles[implementation]);return
  }
  const caseName=request.url?.slice(1)
  if(!cases.includes(caseName)){response.writeHead(404);response.end();return}
  const mismatch=caseName.endsWith('mismatch')
  const nav=mismatch?'<div>Navigation</div>':'<a href="#context">Navigation</a>'
  const contents=nav+'<button id="consumer">outer-value/inner-value/0</button>'
  const body=caseName.startsWith('document')?contents:
    '<div id="root">'+(caseName.startsWith('nested')?'<main>'+contents+'</main>':contents)+'</div>'
  response.setHeader('Content-Type','text/html')
  response.end('<!doctype html><html><head><title>Context probe</title></head><body>'+body+'</body></html>')
})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
try{
  const origin='http://127.0.0.1:'+server.address().port
  for(const [browserName,type] of Object.entries({chromium,firefox,webkit})){
    const browser=await type.launch({headless:true})
    try{
      for(const implementation of ['react','redact'])for(const caseName of cases){
        const page=await browser.newPage()
        const row={browser:browserName,version:browser.version(),implementation,caseName,pageErrors:[],passed:false}
        page.on('pageerror',error=>row.pageErrors.push(String(error)))
        try{
          await page.goto(origin+'/'+caseName)
          await page.evaluate(value=>{globalThis.__hydrationCase=value},caseName)
          await page.addScriptTag({url:origin+'/bundle/'+implementation})
          await page.waitForFunction(()=>globalThis.__contextProbe&&document.getElementById('consumer'))
          await page.waitForFunction(()=>globalThis.__contextProbe.read().events.length>0)
          row.initial=await page.evaluate(()=>globalThis.__contextProbe.read())
          await page.evaluate(()=>globalThis.__contextProbe.click())
          row.afterClick=await page.evaluate(()=>globalThis.__contextProbe.read())
          if(row.initial.text==='outer-value/inner-value/0'){
            await page.evaluate(()=>globalThis.__contextProbe.update())
            await page.waitForFunction(()=>globalThis.__contextProbe.read().events.some(event=>event.kind==='mount'&&event.outside==='outer-updated'))
            row.afterProviderUpdate=await page.evaluate(()=>globalThis.__contextProbe.read())
          }
          assert.equal(row.initial.text,'outer-value/inner-value/0','Hydration lost provider context')
          assert.equal(row.afterClick.text,'outer-value/inner-value/1','Recovered event/state update lost provider context')
          assert.equal(row.afterProviderUpdate.text,'outer-updated/inner-value/1','Provider update lost state or ancestry')
          for(const state of [row.initial,row.afterClick,row.afterProviderUpdate]){
            assert.deepEqual(state.errors.uncaught,[])
            assert.deepEqual(state.errors.caught,[])
            assert.equal(state.errors.recoverable.length,caseName.endsWith('mismatch')?1:0,'Unexpected hydration recovery count')
            assert.equal(state.subscriptions,1,'Abandoned hydration subscriptions survived')
            assert.equal(state.htmlElements,1);assert.equal(state.bodyElements,1)
          }
          await page.evaluate(()=>globalThis.__contextProbe.unmount())
          row.afterUnmount=await page.evaluate(()=>globalThis.__contextProbe.read())
          assert.equal(row.afterUnmount.subscriptions,0,'Unmount leaked a subscription')
          assert.equal(row.afterUnmount.events.filter(event=>event.kind==='mount').length,
            row.afterUnmount.events.filter(event=>event.kind==='cleanup').length,'Unmount missed an effect cleanup')
          assert.deepEqual(row.pageErrors,[])
          row.passed=true
        }catch(error){row.failure=String(error)}
        finally{await page.close()}
        report.rows.push(row)
        console.log(JSON.stringify({browser:browserName,implementation,caseName,passed:row.passed,text:row.initial?.text,failure:row.failure}))
      }
    }finally{await browser.close()}
  }
  for(const implementation of ['react','redact'])for(const file of inputs[implementation+'Sources'])
    assert.equal(hash(readFileSync(resolve(file.filename))),file.sha256,'Renderer source changed during probe')
  assert.equal(hash(readFileSync(fixture)),inputs.fixtureSHA256)
  assert.equal(hash(readFileSync(join(runner,'package-lock.json'))),inputs.runnerLockSHA256)
  report.inputsUnchanged=true
  report.passed=report.rows.length===36&&report.rows.every(row=>row.passed)
}finally{
  await new Promise(resolve=>server.close(resolve))
  const output=join(directory,'results.json')
  writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
  console.log('HOST_HYDRATION_CONTEXT_REPORT '+output)
}
if(!report.passed)process.exitCode=1
