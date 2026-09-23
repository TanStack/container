import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'

const root=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
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
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

const workerCode=`const {parentPort}=require('node:worker_threads');parentPort.on('message',value=>{const instance=new WebAssembly.Instance(value);parentPort.postMessage({module:value instanceof WebAssembly.Module,instance:instance instanceof WebAssembly.Instance,exports:Object.keys(instance.exports)});});parentPort.postMessage({ready:true});`
const preamble=`const {Worker}=require('node:worker_threads');
const workers=[];const evidence={};
function start(){return new Promise((resolve,reject)=>{const w=new Worker(${JSON.stringify(workerCode)},{eval:true,execArgv:['--input-type=commonjs']});workers.push(w);w.once('error',reject);w.once('message',()=>resolve(w));});}
function errorValue(error){return {name:error.name,code:error.code,message:error.message};}
`
const cases=[
  {name:'worker allocation ceiling is enforced while parent remains usable',allocationPolicy:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const {Worker}=require('node:worker_threads');
(async()=>{const evidence={firstStarted:true};const w=new Worker(${JSON.stringify(`const {parentPort}=require('node:worker_threads');try{const buffer=new ArrayBuffer(20*1024*1024);parentPort.postMessage({allocated:buffer.byteLength})}catch(error){parentPort.postMessage({rejected:true,name:error.name,message:error.message})}`)},{eval:true,execArgv:['--input-type=commonjs']});try{evidence.worker=await new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject)})}finally{await w.terminate()}const buffer=new ArrayBuffer(20*1024*1024);new Uint8Array(buffer)[0]=42;evidence.parent={allocated:buffer.byteLength,value:new Uint8Array(buffer)[0]};console.log(JSON.stringify(evidence))})().catch(error=>{console.error(error.stack);process.exitCode=1});`},
  {name:'host worker ceiling permits five small workers within the aggregate reservation',maxBytes:256*1024*1024,workerMaxBytes:16*1024*1024,source:`${preamble}
(async()=>{try{for(let i=0;i<5;i++)await start();evidence.firstStarted=true;evidence.started=workers.length}finally{for(const w of workers)await w.terminate()}console.log(JSON.stringify(evidence));})().catch(error=>{console.error(error.stack);process.exitCode=1});`},
  {name:'explicit aggregate reservation error on second child',maxBytes:256*1024*1024,source:`${preamble}
(async()=>{try{await start();evidence.firstStarted=true;console.log('phase:first-started');try{await start();evidence.secondStarted=true}catch(error){evidence.secondError=errorValue(error)}}finally{for(const w of workers)await w.terminate()}console.log(JSON.stringify(evidence));})().catch(error=>{console.error(error.stack);process.exitCode=1});`,
    expectedError:{code:'ERR_RESOURCE_LIMIT',message:'Aggregate process memory reservations exceed 512 MiB'}},
  {name:'large valid module clone instantiates in recipient with native parity',maxBytes:16*1024*1024,source:`${preamble}
(async()=>{try{const w=await start();evidence.firstStarted=true;
const leb=n=>{const a=[];do{const b=n&127;n>>>=7;a.push(b|(n?128:0))}while(n);return a};
const section=new Uint8Array(70002);section[0]=1;section[1]=120;
const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,0,...leb(section.length),...section]);
const module=new WebAssembly.Module(bytes);evidence.byteLength=bytes.length;evidence.valid=true;
try{const delivered=new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject)});w.postMessage(module);evidence.received=await delivered}catch(error){evidence.transferError=errorValue(error)}
}finally{for(const w of workers)await w.terminate()}console.log(JSON.stringify(evidence));})().catch(error=>{console.error(error.stack);process.exitCode=1});`,
    },
]

for(const sample of cases)test(`packaged worker ${sample.expectedError?'explicit limit diagnostic':'compatibility'}: ${sample.name}`,async({page},info)=>{
  test.skip(!manifest.buildProfile.startsWith('experimental-fibers'),'Requires fiber package')
  test.setTimeout(60000)
  const native=spawnSync(process.execPath,['-e',sample.source],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const nativeResult=JSON.parse(native.stdout.trim().split('\n').at(-1))
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async sample=>{
    const kernel=new window.sdk.WorkerKernel({'/project/main.cjs':sample.source},{experimentalFibers:true,maxBytes:sample.maxBytes,workerMaxBytes:sample.workerMaxBytes,timeoutMs:15000})
    const output=[],samples=[];let result,error,closeError
    const pending=[]
    try{result=await kernel.runModule('/project/main.cjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:sample.maxBytes,timeoutMs:15000,onOutput:(level,text)=>{output.push({level,text});if(text.includes('phase:first-started'))pending.push(kernel.resources().then(value=>samples.push(value)).catch(error=>samples.push({error:error.message})))}});await Promise.all(pending);samples.push(await kernel.resources())}
    catch(cause){error={name:cause.name,message:cause.message}}
    finally{try{kernel.close()}catch(cause){closeError={message:cause.message}}}
    return {result,error,closeError,output,samples}
  },sample)
  const path=info.outputPath('worker-capacity.json')
  await writeFile(path,JSON.stringify({sdk:root,profile:manifest.buildProfile,sample,native:{status:native.status,stdout:native.stdout,stderr:native.stderr,result:nativeResult},observed},null,2))
  await info.attach('worker-capacity.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr).toBe(0)
  const result=JSON.parse(observed.result.stdout.trim().split('\n').at(-1))
  expect(result.firstStarted).toBe(true)
  if(sample.allocationPolicy){expect(nativeResult.worker).toEqual({allocated:20*1024*1024});expect(result.worker).toMatchObject({rejected:true});expect(result.worker.message).toMatch(/memory|allocation/i);expect(result.parent).toEqual({allocated:20*1024*1024,value:42});expect(result.parent).toEqual(nativeResult.parent);expect(observed.samples.at(-1).processes.active).toBe(0)}
  else if(sample.expectedError){expect(nativeResult.secondStarted).toBe(true);expect(result.secondError?.code).toBe(sample.expectedError.code);expect(result.secondError?.message.startsWith(sample.expectedError.message)).toBe(true)}
  else if(sample.workerMaxBytes){expect(result.started).toBe(5);expect(result).toEqual(nativeResult);expect(observed.samples.at(-1).processes.active).toBe(0)}
  else{expect(nativeResult.received).toEqual({module:true,instance:true,exports:[]});expect(result.transferError).toBeUndefined();expect(result).toEqual(nativeResult)}
  expect(observed.closeError).toBeUndefined()
})
