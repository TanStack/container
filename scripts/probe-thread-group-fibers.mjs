import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
const directory=mkdtempSync(join(tmpdir(),'thread-group-fibers-'))
const qjs=resolve('.toolchains/quickjs-emscripten/vendor/quickjs')
const exe=join(directory,'probe.cjs')
execFileSync(resolve('.toolchains/emsdk/upstream/emscripten/emcc'),['-O1','-D_GNU_SOURCE','-DCONFIG_VERSION="probe"','-I'+qjs,resolve('fixtures/thread-group-fibers.c'),...['quickjs','dtoa','libregexp','libunicode','cutils'].map(name=>join(qjs,name+'.c')),'-lm','-sASYNCIFY=1','-sASSERTIONS=2','-sALLOW_MEMORY_GROWTH=1','-sSTACK_SIZE=1048576','-o',exe],{stdio:'inherit'})
execFileSync(process.execPath,[exe],{stdio:'inherit',timeout:15000})
console.log('Thread-group continuation proof:',exe)
if(process.argv.includes('--browser')){
  const {createServer}=await import('node:http')
  const {chromium,firefox,webkit}=await import('playwright')
  const server=createServer((req,res)=>{
    if(req.url==='/'){
      res.setHeader('content-type','text/html')
      res.end('<script>window.output=[];window.failure=null;var Module={print:text=>output.push(text),printErr:text=>output.push(text),onAbort:reason=>window.failure=String(reason)};</script><script src="/probe.cjs"></script>')
    }else if(req.url==='/probe.cjs'||req.url==='/probe.wasm'){
      res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript')
      res.end(readFileSync(join(directory,req.url.slice(1))))
    }else{res.statusCode=404;res.end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const results=[]
  try{
    for(const [name,type] of Object.entries({chromium,firefox,webkit})){
      const browser=await type.launch()
      try{
        const page=await browser.newPage()
        const errors=[];page.on('pageerror',error=>errors.push(error.message))
        await page.goto(`http://127.0.0.1:${server.address().port}/`)
        await page.waitForFunction(()=>window.failure||window.output.some(line=>line.startsWith('{')),null,{timeout:15000})
        const state=await page.evaluate(()=>({output:window.output,failure:window.failure,isolated:crossOriginIsolated}))
        const result={name,...state,errors};results.push(result)
        if(state.failure||errors.length||!state.output.includes('{"cases":6,"released":6,"peerProgress":true,"cancellation":true,"independentBudget":true,"asyncHost":true,"lateCompletion":true,"overlappingRequests":true}'))throw Error(JSON.stringify(result))
        console.log(name+': thread-group fiber proof passed without cross-origin isolation')
      }finally{await browser.close()}
    }
  }finally{
    writeFileSync('reports/thread-group-fibers.json',JSON.stringify({scope:'Two QuickJS runtimes in one engine using supported fibers and one reference-counted ordinary buffer. Not integrated WASM threads or SharedArrayBuffer semantics.',results},null,2)+'\n')
    await new Promise(resolve=>server.close(resolve))
  }
}
