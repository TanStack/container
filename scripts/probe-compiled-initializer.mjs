import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'

const directory=mkdtempSync(join(tmpdir(),'compiled-initializer-'))
const qjs=resolve('.toolchains/quickjs-emscripten/vendor/quickjs')
const output=join(directory,'probe.cjs')
const args=['-O1','-D_GNU_SOURCE','-DCONFIG_VERSION="probe"','-I',qjs,
 'fixtures/compiled-initializer-probe.c',...['quickjs.c','dtoa.c','libregexp.c','libunicode.c','cutils.c'].map(name=>join(qjs,name)),
 '-sALLOW_MEMORY_GROWTH=1','-sSTACK_SIZE=1048576','-sENVIRONMENT=node',
 '--embed-file','public/vm-web-apis/globals.js@/globals.js','-o',output]
const build=spawnSync(resolve('.toolchains/emsdk/upstream/emscripten/emcc'),args,{encoding:'utf8',timeout:120000})
if(build.status!==0)throw Error(build.stderr||build.error?.message||'Build failed')
const run=spawnSync(process.execPath,[output,'/globals.js'],{encoding:'utf8',timeout:15000})
const expected=JSON.stringify({request:'Request',response:'Response'})
const passed=run.status===0&&run.stdout.trim().split('\n').length===4&&run.stdout.trim().split('\n').every(line=>line===expected)
const report={scope:'Isolated QuickJS WASM serialization feasibility, not the staged production engine or WorkerKernel integration.',sourceSHA256:createHash('sha256').update(readFileSync('public/vm-web-apis/globals.js')).digest('hex'),directory,status:run.status,stdout:run.stdout,stderr:run.stderr,error:run.error?.message,passed}
if(process.argv.includes('--browser')){
 const browserOutput=join(directory,'probe.js')
 const browserArgs=args.map(value=>value==='-sENVIRONMENT=node'?'-sENVIRONMENT=web':value===output?browserOutput:value)
 browserArgs.push('-sMODULARIZE=1','-sEXPORT_NAME=createProbe')
 const browserBuild=spawnSync(resolve('.toolchains/emsdk/upstream/emscripten/emcc'),browserArgs,{encoding:'utf8',timeout:120000})
 if(browserBuild.status!==0)throw Error(browserBuild.stderr||browserBuild.error?.message||'Browser build failed')
 const {createServer}=await import('node:http')
 const {chromium,firefox,webkit}=await import('playwright')
 const server=createServer((req,res)=>{
  if(req.url==='/'){
   res.setHeader('content-type','text/html');res.end(`<script src="/probe.js"></script><script>
   const stdout=[],stderr=[];createProbe({arguments:['/globals.js'],print:line=>stdout.push(line),printErr:line=>stderr.push(line)}).then(()=>window.result={stdout,stderr}).catch(error=>window.failure=String(error));
   </script>`);return
  }
  if(['/probe.js','/probe.wasm'].includes(req.url)){
   res.setHeader('content-type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(readFileSync(join(directory,req.url.slice(1))));return
  }
  res.statusCode=404;res.end()
 })
 await new Promise(done=>server.listen(0,'127.0.0.1',done));report.browsers=[]
 try{
  for(const [name,type] of Object.entries({chromium,firefox,webkit})){
   const browser=await type.launch()
   try{
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.waitForFunction(()=>window.result||window.failure,null,{timeout:30000})
    const observed=await page.evaluate(()=>({result:window.result,error:window.failure}))
    const passed=!observed.error&&observed.result.stdout.length===4&&observed.result.stdout.every(line=>line===expected)
    report.browsers.push({name,...observed,passed});if(!passed){report.passed=false;process.exitCode=1}
   }finally{await browser.close()}
  }
 }finally{await new Promise(done=>server.close(done))}
}
writeFileSync('reports/compiled-initializer.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2));if(!passed)process.exitCode=1
