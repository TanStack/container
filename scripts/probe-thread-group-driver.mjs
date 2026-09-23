import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const directory=mkdtempSync(join(tmpdir(),'thread-group-driver-'))
const qjs=resolve('.toolchains/quickjs-emscripten/vendor/quickjs')
const exe=join(directory,'engine.mjs')
execFileSync(resolve('.toolchains/emsdk/upstream/emscripten/emcc'),['-O1','-D_GNU_SOURCE','-DCONFIG_VERSION="probe"','-I'+qjs,resolve('fixtures/thread-group-driver.c'),...['quickjs','dtoa','libregexp','libunicode','cutils'].map(name=>join(qjs,name+'.c')),'-lm','--no-entry','-sMODULARIZE=1','-sEXPORT_ES6=1','-sEXPORTED_RUNTIME_METHODS=cwrap','-sASYNCIFY=1','-sASSERTIONS=2','-sALLOW_MEMORY_GROWTH=1','-sSTACK_SIZE=1048576','-o',exe],{stdio:'inherit'})
const {default:create}=await import(pathToFileURL(exe).href)
const engine=await create()
await build({entryPoints:['scripts/thread-group-driver-harness.mjs'],outfile:join(directory,'harness.mjs'),bundle:true,platform:'browser',format:'esm'})
const {runDriver}=await import(pathToFileURL(join(directory,'harness.mjs')).href)
const {readFile}=await import('node:fs/promises')
const native=await runDriver(engine,async()=>Number(await readFile('fixtures/thread-group-host.txt','utf8')))
console.log(JSON.stringify({native,directory}))
if(process.argv.includes('--browser')){
  const {createServer}=await import('node:http')
  const {chromium,firefox,webkit}=await import('playwright')
  const server=createServer((req,res)=>{
    if(req.url==='/'){
      res.setHeader('content-type','text/html')
      res.end('<script type="module">import create from "/engine.mjs";import {runDriver} from "/harness.mjs";try{window.result=await runDriver(await create(),async()=>Number(await (await fetch("/input.txt")).text()))}catch(error){window.failure=String(error)}</script>')
    }else if(['/engine.mjs','/engine.wasm','/harness.mjs','/input.txt'].includes(req.url)){
      res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':req.url.endsWith('.mjs')?'text/javascript':'text/plain')
      res.end(readFileSync(req.url==='/input.txt'?'fixtures/thread-group-host.txt':join(directory,req.url.slice(1))))
    }else{res.statusCode=404;res.end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const results=[]
  try{
    for(const [name,type] of Object.entries({chromium,firefox,webkit})){
      const browser=await type.launch()
      try{
        const page=await browser.newPage(),errors=[]
        page.on('pageerror',error=>errors.push(error.message))
        await page.goto(`http://127.0.0.1:${server.address().port}/`)
        await page.waitForFunction(()=>window.result||window.failure,null,{timeout:15000})
        const state=await page.evaluate(()=>({result:window.result,failure:window.failure,isolated:crossOriginIsolated}))
        results.push({name,...state,errors})
        if(state.failure||errors.length||JSON.stringify(state.result)!==JSON.stringify(native))throw Error(JSON.stringify(results.at(-1)))
        console.log(name+': external fiber scheduler and mailbox passed')
      }finally{await browser.close()}
    }
  }finally{
    writeFileSync('reports/thread-group-driver.json',JSON.stringify({scope:'Exported fiber candidate using actual TaskScheduler and ThreadGroupMailbox with host file I/O. Not production WorkerKernel integration or shared WASM.',native,results},null,2)+'\n')
    await new Promise(resolve=>server.close(resolve))
  }
}
