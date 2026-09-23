import {test,expect} from '@playwright/test'
import {build} from 'esbuild'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync,mkdtempSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {resolve,join,extname,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {files} from './compile.mjs'
import {parseCases} from './parse-cases.mjs'
// @ts-expect-error Node build script has no runtime declaration.
import {buildRolldownParser} from '../../../scripts/build-rolldown-parser.mjs'

const here=resolve('tests/fixtures/rolldown-native-probe')
const sdk=realpathSync(process.env.SDK_OUTPUT!)
const binding=join(here,'node_modules/@rolldown/binding-wasm32-wasi')
const manifest=JSON.parse(readFileSync(join(binding,'package.json'),'utf8'))
if(manifest.version!=='1.2.9')throw Error('Probe requires exact binding1.2.9')
const wasm=readFileSync(join(binding,'rolldown-binding.wasm32-wasi.wasm'))
const inputs=JSON.parse(readFileSync(join(here,'inputs.json'),'utf8'))
for(const [path,key]of [[join(here,'package-lock.json'),'lockSHA256'],[join(binding,'rolldown-binding.wasm32-wasi.wasm'),'wasmSHA256'],[join(binding,'wasi-worker-browser.mjs'),'pthreadSHA256']]){
  if(createHash('sha256').update(readFileSync(path)).digest('hex')!==inputs[key])throw Error('Pinned compiler input changed: '+path)
}
let server:Server,url:string
const built=realpathSync(mkdtempSync(join(tmpdir(),'rolldown-native-browser-')))
test.beforeAll(async()=>{
  await buildRolldownParser(here,join(built,'parser'))
  await build({entryPoints:[resolve('src/compiler/rolldown-parser.ts')],outfile:join(built,'parser-owner.js'),bundle:true,platform:'browser',format:'esm',target:'es2022'})
  await build({entryPoints:[join(here,'sync-profile.worker.mjs')],outfile:join(built,'sync-profile.worker.js'),bundle:true,platform:'browser',format:'esm',target:'es2022'})
  await build({entryPoints:{owner:resolve('src/compiler/rolldown-probe-session.ts'),compiler:resolve('src/compiler/rolldown-probe.worker.mjs'),pthread:join(binding,'wasi-worker-browser.mjs')},outdir:built,bundle:true,platform:'browser',format:'esm',target:'es2022'})
  server=createServer((req,res)=>{
    res.setHeader('Cross-Origin-Opener-Policy','same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    res.setHeader('Cross-Origin-Resource-Policy','same-origin')
    const path=new URL(req.url!,'http://localhost').pathname
    if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";import {RolldownProbeSession} from "/owner.js";import {NativeRolldownParser} from "/parser-owner.js";window.NativeParser=NativeRolldownParser;window.Session=RolldownProbeSession;window.sdk=sdk;</script>');return}
    if(path==='/compiler.wasm'){res.setHeader('Content-Type','application/wasm');res.end(wasm);return}
    try{
      const root=path.startsWith('/sdk/')?sdk:built
      if(root===built&&!['/owner.js','/compiler.js','/pthread.js','/parser-owner.js','/sync-profile.worker.js','/parser/worker.js','/parser/pthread.js','/parser/parser.wasm'].includes(path))throw Error('Unknown route')
      const file=realpathSync(resolve(root,path.startsWith('/sdk/')?path.slice(5):path.slice(1)))
      if(!file.startsWith(root+sep))throw Error('Outside files')
      res.setHeader('Content-Type',extname(file)==='.wasm'?'application/wasm':'text/javascript');res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${(server.address() as any).port}`
})
test.afterAll(async()=>{if(server)await new Promise<void>(done=>server.close(()=>done()))})

test('native parser session matches Node for JS, TS, JSX, bigint, regex and errors',async({page},info)=>{
  const native=spawnSync(process.execPath,[join(here,'parse-reference.mjs')],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  const reference=JSON.parse(native.stdout)
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).Session))
  const result=await page.evaluate(async cases=>{
    const session=await (window as any).NativeParser.open({createWorker:()=>new Worker('/parser/worker.js',{type:'module'}),wasmURL:location.origin+'/parser/parser.wasm',pthreadURL:location.origin+'/parser/pthread.js',policy:{timeoutMs:30000,maxSourceBytes:1024*1024}})
    try{
      const results=[]
      for(const item of cases)results.push({name:item.name,result:await session.parse(item.filename,item.source,item.options)})
      let invalidInput=''
      try{await session.parse('large.js','x'.repeat(1024*1024+1))}catch(error){invalidInput=String(error)}
      const resources=await session.close()
      return {results,resources,invalidInput}
    }finally{await session.close()}
  },parseCases).catch(async error=>{
    const path=info.outputPath('native-parser-failure.json')
    await writeFile(path,JSON.stringify({error:String(error),stack:error instanceof Error?error.stack:undefined,reference,wasmSHA256:createHash('sha256').update(wasm).digest('hex')},null,2))
    await info.attach('native-parser-failure',{path,contentType:'application/json'})
    throw error
  })
  await writeFile(info.outputPath('native-parser-evidence.json'),JSON.stringify({result,reference,wasmSHA256:createHash('sha256').update(wasm).digest('hex')},null,2))
  expect(result.results).toEqual(reference)
  expect(reference.find((item:any)=>item.name==='invalid syntax').result.errors.length).toBeGreaterThan(0)
  expect(reference.filter((item:any)=>item.name!=='invalid syntax').every((item:any)=>item.result.errors.length===0)).toBe(true)
  expect(result.resources.active).toBe(0)
  expect(result.resources.sharedMaximumBytes).toBe(1280*1024*1024)
  expect(result.invalidInput).toContain('Native parser input exceeds owner policy')
})

test('reduced synchronous compiler profile parses, transforms and owns one async worker',async({page})=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).NativeParser))
  const result=await page.evaluate(()=>new Promise<any>((resolve,reject)=>{const worker=new Worker('/sync-profile.worker.js',{type:'module'});worker.onmessage=event=>{worker.terminate();event.data.error?reject(Error(event.data.error+'\n'+event.data.stack)):resolve(event.data)};worker.onerror=event=>reject(Error(event.message))}))
  expect(result.parsed).toEqual({errors:0,hasProgram:true})
  expect(result.transformed.errors).toEqual([])
  expect(result.transformed.code).toContain('export const answer = 42')
  expect(result.size).toBe(0)
  expect(result.resources).toMatchObject({active:0,sharedInitialBytes:64*1024*1024,sharedMaximumBytes:512*1024*1024,peak:1})
})

test('native compiler session updates with async guest hooks match Node',async({page},info)=>{
  const native=spawnSync(process.execPath,[join(here,'reference.mjs')],{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr).toBe(0)
  const reference=JSON.parse(native.stdout)
  expect(reference.rounds.map((round:any)=>round.value)).toEqual([42,43])
  const guestFiles=Object.fromEntries(['guest.mjs','plugin.mjs'].map(name=>['/'+name,readFileSync(join(here,name),'utf8')]))
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async({guestFiles:files,workspace})=>{
    if(!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw Error('COI/SAB preflight failed')
    const state:any=(window as any).probe={callbacks:[],workerEvents:[]}
    const kernel=state.kernel=new (window as any).sdk.WorkerKernel(files,{maxBytes:64*1024*1024})
    const child=await kernel.spawn('node',['/guest.mjs'],{lifetime:'session',maxBytes:64*1024*1024,timeoutMs:30000})
    const pending=new Map<number,{resolve(value:any):void,reject(error:any):void}>()
    let readyResolve!:(()=>void),readyReject!:((error:any)=>void)
    const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject})
    let buffer=''
    const drain=(async()=>{try{for(;;){const event=await child.next();if(event?.type==='stdout'){
      buffer+=new TextDecoder().decode(event.bytes)
      for(;;){const newline=buffer.indexOf('\n');if(newline<0)break;const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1)
        if(line==='GUEST_READY'){readyResolve();continue}
        const reply=JSON.parse(line),waiter=pending.get(reply.id);pending.delete(reply.id);reply.error?waiter?.reject(Error(reply.error)):waiter?.resolve(reply.value)
      }
    }else if(!event||event.type==='exit')break}}catch(error){readyReject(error);for(const waiter of pending.values())waiter.reject(error)}})()
    let session:any,callbackId=0,round=0
    try{
      await ready
      session=await (window as any).Session.open({
        createWorker:()=>new Worker('/compiler.js',{type:'module'}),files:workspace,
        async callback(method:string,args:unknown[]){
          if(state.callbacks.length>=128)throw Error('Callback count ceiling')
          state.callbacks.push({round,method,args})
          const id=++callbackId,reply=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))
          await child.write(JSON.stringify({id,method,args})+'\n');return reply
        },
      })
      const rounds=[]
      for(round=0;round<2;round++){
        // Queue the second compile immediately behind its update, exercising ordering.
        const update=round===1?session.writeFile('/project/value.js','export default 40'):Promise.resolve()
        const compiling=session.compile()
        await update
        const result=await compiling
        const module=await import(/* @vite-ignore */'data:text/javascript,'+encodeURIComponent(result.chunks[0].code))
        rounds.push({...result,value:module.default})
      }
      const resources=await session.close()
      let closedError=''
      try{await session.compile()}catch(error){closedError=String(error)}
      state.result={rounds,resources,closedError}
      return {...state.result,callbacks:state.callbacks}
    }finally{try{if(session)await session.close()}finally{await child.dispose();await drain;kernel.close();state.ownerClosed=true}}
  },{guestFiles,workspace:files}).catch(async error=>{
    const state=await page.evaluate(()=>{const s=(window as any).probe;return {result:s?.result,callbacks:s?.callbacks,ownerClosed:s?.ownerClosed}})
    const path=info.outputPath('failed-state.json')
    await writeFile(path,JSON.stringify({state,error:String(error),wasmSHA256:createHash('sha256').update(wasm).digest('hex')},null,2))
    await info.attach('failed-state',{path,contentType:'application/json'})
    throw error
  })
  const evidence={result,reference,wasmSHA256:createHash('sha256').update(wasm).digest('hex'),lockSHA256:createHash('sha256').update(readFileSync(join(here,'package-lock.json'))).digest('hex')}
  await writeFile(info.outputPath('native-compiler-evidence.json'),JSON.stringify(evidence,null,2))
  expect(result.rounds.map((round:any)=>round.value)).toEqual(reference.rounds.map((round:any)=>round.value))
  expect(result.resources.active).toBe(0)
  expect(result.resources.sharedMaximumBytes).toBe(1280*1024*1024)
  expect(result.closedError).toContain('Compiler session is closed')
  for(const round of [0,1]){
    expect(result.callbacks.some((row:any)=>row.round===round&&row.method==='load'&&row.args[0]==='\0virtual:answer')).toBe(true)
    expect(result.callbacks.some((row:any)=>row.round===round&&row.method==='transform'&&row.args[0]==='/project/value.js')).toBe(true)
  }
})
