import {build, transform} from 'esbuild'
import {readFile, writeFile, mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {AsyncLocalStorage} from 'node:async_hooks'
import {chromium, firefox} from '@playwright/test'

// Deliberately separate from release acceptance and frozen package candidates.
const output = await mkdtemp(join(tmpdir(), 'browser-native-spike-'))
const optimized=process.argv.includes('--optimized')
const engineDirectory=optimized
  ? 'public/quickjs-als-asyncify-wasm-o2-atomics-interpreter-machine-batched-one-caller50-assignments-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls-module-import-exports-native-utf8-buffer'
  : 'public/quickjs-als'
const corpusBytes = await readFile('src/feasibility/als-cases.json', 'utf8')
const cases = JSON.parse(corpusBytes)
const bootstrap = await readFile('src/sandbox/engine-als-bootstrap.js', 'utf8')
await build({entryPoints:['src/feasibility/browser-native.worker.js'],bundle:true,
  format:'esm',platform:'browser',external:['/engine.mjs'],outfile:join(output,'worker.js'),logLevel:'silent'})
const fixtures = []
for (const fixture of cases) {
  const expected = JSON.stringify(await new Function('ALS', `return (async()=>{${fixture.code}})()`)(AsyncLocalStorage))
  const code = `(async()=>{const ALS=globalThis.__engineAsyncLocalStorage;${fixture.code}})()`
  const lowered = (await transform(`globalThis.__probeResult=${code}`, {target:'es2016'})).code + '\n globalThis.__probeResult;'
  fixtures.push({...fixture, code, lowered, expected})
}
const workload = await build({stdin:{contents:`
  import React from 'react';
  import {renderToString} from 'react-dom/server.browser';
  import {Volume, createFsFromVolume} from 'memfs';
  const fs=createFsFromVolume(Volume.fromJSON({'/message.txt':'browser-native SSR'}));
  const html=renderToString(React.createElement('h1',null,fs.readFileSync('/message.txt','utf8')));
  globalThis.__workload={html, passed:html==='<h1>browser-native SSR</h1>'};
`,resolveDir:resolve('.')},bundle:true,write:false,format:'iife',platform:'browser',
  alias:{'node:buffer':'buffer/','node:events':'events/','node:path':'path-browserify','node:stream':'stream-browserify'},
  define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'})
const workloadCode = workload.outputFiles[0].text + '\nglobalThis.__workload;'
const iterations=Number(process.argv.find(arg=>arg.startsWith('--iterations='))?.split('=')[1]??10000000)
if(!Number.isSafeInteger(iterations)||iterations<1||iterations>10000000)throw Error('Expected iterations between 1 and 10000000')
const benchmark = `(()=>{let result=0;for(let i=0;i<${iterations};i++)result=(result+((i*17)^ (i>>>3)))|0;return result})()`
const expectedBenchmark = (0,eval)(benchmark)
const report = {generatedAt:new Date().toISOString(),node:process.version,
  corpusSHA256:createHash('sha256').update(corpusBytes).digest('hex'),
  inputs:Object.fromEntries(await Promise.all([
    'src/feasibility/browser-native.worker.js','src/sandbox/engine-als-bootstrap.js',
    engineDirectory+'/engine.mjs',engineDirectory+'/engine.wasm',
  ].map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')]))),
  scope:'Architecture probe, not Node/Vite/Start compatibility or production isolation acceptance',
  methodology:{iterations,benchmark:'Integer arithmetic iterations, four fresh-worker samples per engine; executionMs excludes engine setup but includes evaluation and result extraction',
    quickjs:engineDirectory+'; direct context evaluation, not full SDK workload scheduling',
    workload:'Host-prebundled React server.browser + memfs, explicit buffer/events/path/stream browser adapters; not guest npm installation or dynamic Node module loading'},
  output, browsers:[]}
const server = createServer(async (req,res) => {
  try {
    res.setHeader('Cross-Origin-Opener-Policy','same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    const routes = {'/worker.js':join(output,'worker.js'),'/engine.mjs':resolve('public/quickjs-als/engine.mjs'),'/engine.wasm':resolve('public/quickjs-als/engine.wasm')}
    if(optimized)for(const file of ['core.mjs','engine.mjs','ffi.mjs','engine.wasm'])routes['/optimized/'+file]=resolve(engineDirectory,file)
    if (req.url === '/') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Browser-native architecture probe</title>');return}
    const path=routes[req.url]
    if (!path) {res.writeHead(404);res.end();return}
    res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript')
    res.end(await readFile(path))
  } catch(error) {res.writeHead(500);res.end(String(error))}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
try {
  for (const [name,type] of [['chromium',chromium],['firefox',firefox]]) {
    const browser=await type.launch({headless:true})
    try {
      const page=await browser.newPage()
      await page.goto(`http://127.0.0.1:${server.address().port}/`)
      const result=await page.evaluate(async ({fixtures,bootstrap,workloadCode,benchmark,expectedBenchmark,optimized})=>{
        const run=(mode,code)=>new Promise(resolve=>{
          const started=performance.now(),worker=new Worker('/worker.js',{type:'module'})
          const finish=result=>{clearTimeout(timer);worker.terminate();resolve({...result,wallMs:performance.now()-started})}
          const timer=setTimeout(()=>finish({ok:false,error:'Probe timeout'}),15000)
          worker.onerror=event=>finish({ok:false,error:event.message})
          worker.onmessage=event=>finish(event.data)
          worker.postMessage({mode,code,bootstrap,optimized})
        })
        const rows=[]
        for(const fixture of fixtures){
          const row={id:fixture.id,expected:fixture.expected}
          for(const [mode,code] of [['native',fixture.code],['transformed',fixture.lowered],['quickjs',fixture.code]]){
            const actual=await run(mode,code)
            row[mode]={...actual,matches:actual.ok&&JSON.stringify(actual.value)===fixture.expected}
          }
          rows.push(row)
        }
        const samples={}
        // Each sample includes a new worker/runtime; elapsedMs is not pure CPU time.
        for(const mode of ['native','quickjs']){
          samples[mode]=[]
          for(let i=0;i<4;i++){
            const sample=await run(mode,benchmark)
            samples[mode].push({...sample,matches:sample.ok&&sample.value===expectedBenchmark})
          }
        }
        return {userAgent:navigator.userAgent,crossOriginIsolated,rows,samples,
          workload:await run('native',workloadCode),
          ambient:await run('native',`({fetch:typeof fetch,indexedDB:typeof indexedDB,WebSocket:typeof WebSocket,process:typeof process})`)}
      },{fixtures,bootstrap,workloadCode,benchmark,expectedBenchmark,optimized})
      report.browsers.push({name,version:browser.version(),...result})
      console.log(name,JSON.stringify({matches:Object.fromEntries(['native','transformed','quickjs'].map(mode=>[mode,result.rows.filter(row=>row[mode].matches).length])),total:fixtures.length,workload:result.workload}))
    } finally {await browser.close()}
  }
} finally {await new Promise(resolve=>server.close(resolve))}
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n')
await writeFile(resolve('reports',`native-engine-${report.generatedAt.replaceAll(':','-')}.json`),JSON.stringify(report,null,2)+'\n')
console.log('REPORT='+join(output,'report.json'))
if(report.browsers.some(browser=>browser.rows.some(row=>!row.quickjs.matches)||!browser.workload.ok||!browser.workload.value.passed||Object.values(browser.samples).flat().some(row=>!row.matches)))process.exitCode=1
