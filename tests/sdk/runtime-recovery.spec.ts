import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'
import {observeSDKEngines} from './engine-evidence'

const root=realpathSync(process.env.SDK_OUTPUT!)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
let server:Server,url:string
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname
    if(path==='/consumer/'){
      res.setHeader('content-type','text/html');res.end('<!doctype html><script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk;</script>');return
    }
    try{
      if(!path.startsWith('/consumer/vendor/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice('/consumer/vendor/'.length))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${(server.address() as {port:number}).port}/consumer/`
})
test.afterAll(async()=>{if(server)await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

const overflows={
  recursion:`function recur(n){depth=n;if(n===8192)return 42;return 1+recur(n+1)}recur(0)`,
  generator:`function* recur(n){depth=n;if(n===1024)return 42;return recur(n+1).next().value}recur(0).next()`,
  async:`async function recur(n){depth=n;if(n===1024)return 42;return 1+await recur(n+1)}await recur(0)`,
  'async-generator':`async function* recur(n){depth=n;if(n===1024)return 42;return (await recur(n+1).next()).value}await recur(0).next()`,
}
const cases=[
  {name:'infinite JavaScript loop',source:`console.log('probe-start');globalThis.probeState='dirty';await 0;for(;;){};console.log('unexpected-success')`,timeoutMs:100,maxBytes:4*1024*1024,kind:'interrupt'},
  {name:'bounded heap allocation failure',source:`console.log('probe-start');globalThis.probeState='dirty';new Uint8Array(8*1024*1024);console.log('unexpected-success')`,timeoutMs:5000,maxBytes:4*1024*1024,kind:'memory'},
  ...Object.entries(overflows).map(([name,code])=>({name:name+' overflow',source:`globalThis.probeState='dirty';let depth=0,caught='';try{${code}}catch(error){caught=String(error)}console.log(JSON.stringify({depth,caught,answer:42}));`,timeoutMs:5000,maxBytes:16*1024*1024,kind:'stack',ceiling:name==='recursion'?8192:1024})),
]

for(const guestWasm of [false,true])for(const probe of cases)test(`packaged synchronous runtime recovery: ${probe.name}, guestWasm=${guestWasm}`,async({page},info)=>{
  const slot=guestWasm?'quickjs-als-wasm':'quickjs-als'
  const evidence=observeSDKEngines(page,info,root,slot)
  try{
    const metadata=manifest.engines?.[slot]?.metadata
    expect(metadata?.asyncify,'Recovery must exercise the synchronous engine').toBe(false)
    expect(Boolean(metadata?.guestWasm)).toBe(guestWasm)
    if(manifest.buildProfile==='sync-o2')expect(metadata.optimization).toBe('O2')
    await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
    const result=await page.evaluate(async({probe,guestWasm})=>{
      const kernel=new (window as any).sdk.WorkerKernel({'/retained.txt':'workspace retained'},{cooperative:false,maxBytes:16*1024*1024,timeoutMs:5000})
      try{
        const rows=[]
        // Repeated overflows check cleanup paths, not only the first failure.
        for(let index=0;index<(probe.kind==='stack'?3:1);index++){
          const started=performance.now()
          const failure=await kernel.execute(probe.source,{guestWasm,timeoutMs:probe.timeoutMs,maxBytes:probe.maxBytes})
          const failureMs=performance.now()-started
          const recovery=await kernel.execute(`console.log(JSON.stringify({answer:6*7,previous:typeof globalThis.probeState}))`,{guestWasm,timeoutMs:5000,maxBytes:4*1024*1024})
          rows.push({failure,failureMs,recovery})
        }
        return {rows,retained:await kernel.readText('/retained.txt')}
      }finally{kernel.close()}
    },{probe,guestWasm})
    await info.attach('sdk-runtime-recovery.json',{body:JSON.stringify({profile:manifest.buildProfile,slot,probe:probe.name,result}),contentType:'application/json'})
    expect(result.retained).toBe('workspace retained')
    for(const row of result.rows){
      expect(row.failure.stderr).not.toContain('Kernel cleanup failed')
      if(probe.kind==='stack'){
        expect(row.failure.exitCode,row.failure.stderr).toBe(0)
        const value=JSON.parse(row.failure.stdout)
        expect(value.depth).toBeGreaterThan(0)
        if('ceiling' in probe)expect(value.depth).toBeLessThan(probe.ceiling)
        if(probe.name==='recursion overflow'){
          expect(metadata.interpreterFrames.limit).toBe(4096)
          expect(value.depth).toBeLessThanOrEqual(metadata.interpreterFrames.limit)
        }
        expect(value.caught).toMatch(/stack overflow/i);expect(value.answer).toBe(42)
      }else{
        expect(row.failure.exitCode,row.failure.stderr).toBe(1)
        expect(row.failure.stdout).toBe('probe-start\n')
        expect(row.failure.stderr).toMatch(probe.kind==='memory'?/out of memory/i:/interrupt|timed out/i)
        expect(row.failureMs).toBeLessThan(10000)
      }
      expect(row.recovery.exitCode,row.recovery.stderr).toBe(0)
      expect(JSON.parse(row.recovery.stdout)).toEqual({answer:42,previous:'undefined'})
    }
  }finally{await evidence.flush()}
})

test('packaged synchronous WASM loop is interrupted and fresh execution recovers',async({page},info)=>{
  const evidence=observeSDKEngines(page,info,root,'quickjs-als-wasm')
  try{
    expect(manifest.engines?.['quickjs-als-wasm']?.metadata?.asyncify).toBe(false)
    if(manifest.buildProfile==='sync-o2')expect(manifest.engines['quickjs-als-wasm'].metadata.optimization).toBe('O2')
    await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
    const result=await page.evaluate(async()=>{
      const kernel=new (window as any).sdk.WorkerKernel({},{cooperative:false,maxBytes:16*1024*1024,timeoutMs:5000})
      try{
        // A tiny () -> () export containing loop { br 0 }, no memory allocation.
        const source=`const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,7,1,3,114,117,110,0,0,10,9,1,7,0,3,64,12,0,11,11]);const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes));console.log('wasm-start');instance.exports.run();console.log('unexpected-success')`
        const started=performance.now()
        const failure=await kernel.execute(source,{guestWasm:true,timeoutMs:100,maxBytes:4*1024*1024})
        const failureMs=performance.now()-started
        const recovery=await kernel.execute('console.log(42)',{guestWasm:true,timeoutMs:5000,maxBytes:4*1024*1024})
        return {failure,failureMs,recovery}
      }finally{kernel.close()}
    })
    await info.attach('sdk-wasm-loop-recovery.json',{body:JSON.stringify(result),contentType:'application/json'})
    expect(result.failure.exitCode,result.failure.stderr).toBe(1)
    expect(result.failure.stdout).toBe('wasm-start\n')
    expect(result.failure.stderr).toMatch(/interrupt|timed out/i)
    expect(result.failure.stderr).not.toContain('Kernel cleanup failed')
    expect(result.failureMs).toBeLessThan(10000)
    expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
    expect(result.recovery.stdout).toBe('42\n')
  }finally{await evidence.flush()}
})
