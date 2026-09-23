import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'

const root=realpathSync(process.env.SDK_OUTPUT)
let server,url
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
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

const source=`import {Worker} from 'node:worker_threads';
const results=[];
for(const [name,filename,options] of [
 ['missing-absolute','/missing-worker-launch-fixture.mjs',{}],
 ['missing-relative','./missing-worker-launch-fixture.mjs',{}],
 ['missing-file-url',new URL('file:///missing-worker-launch-fixture.mjs'),{}],
 ['throw','throw new Error("worker launch fixture")',{eval:true,execArgv:['--input-type=commonjs']}],
 ['syntax','import "node:fs"',{eval:true,execArgv:['--input-type=commonjs']}],
 ['data-url',new URL('data:text/javascript,export default 42'),{}]
]){
 const events=[];let returned=false;
 const worker=new Worker(filename,options);returned=true;
 worker.on('online',()=>events.push({type:'online'}));
 worker.on('error',error=>events.push({type:'error',returned,name:error.name,...(name.startsWith('missing')?{code:error.code}:{})}));
 const code=await new Promise(resolve=>worker.once('exit',resolve));
 results.push({name,returned,events,code});
}
console.log(JSON.stringify(results));`

test('worker module failures stay asynchronous after launch',async({page},info)=>{
  test.setTimeout(60000)
  const native=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  const expected=JSON.parse(native.stdout.trim())
  for(const row of expected){expect(row.returned).toBe(true);expect(row.events[0]).toEqual({type:'online'});expect(row.code).toBe(row.name==='data-url'?0:1)}
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async source=>{
    const kernel=new window.sdk.WorkerKernel({'/main.mjs':source},{experimentalFibers:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,timeoutMs:15000})
    try{const result=await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:15000});const resources=await kernel.resources();return {result,resources}}finally{kernel.close()}
  },source)
  await info.attach('worker-launch.json',{body:JSON.stringify({sdk:root,native:expected,observed},null,2),contentType:'application/json'})
  expect(observed.result.exitCode,observed.result.stderr).toBe(0)
  expect(JSON.parse(observed.result.stdout.trim())).toEqual(expected)
  expect(observed.resources).toEqual(expect.objectContaining({
    processes:{active:0,retained:0},
    network:{handles:0,listeners:0,details:[]},
    datagrams:{handles:0,bound:0},
    fileSessions:0,
    executing:false,
    installing:false,
  }))
})
