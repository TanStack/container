import {test,expect} from '@playwright/test'
import {build} from 'esbuild'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync,mkdtempSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {resolve,join,extname,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {WorkspaceFiles} from '../../../src/sandbox/files'
// @ts-expect-error Shared executable Node fixture has no runtime declaration.
import {files,symlinks,updateCase} from '../rolldown-native-probe/resolve-cases.mjs'

const here=resolve('tests/fixtures/rolldown-shared-native'),shared=resolve('tests/fixtures/rolldown-native-probe')
const sdk=realpathSync(process.env.SDK_OUTPUT!),modules=join(shared,'node_modules'),binding=join(modules,'@rolldown/binding-wasm32-wasi')
const inputs=JSON.parse(readFileSync(join(shared,'inputs.json'),'utf8'))
const wasm=readFileSync(join(binding,'rolldown-binding.wasm32-wasi.wasm'))
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
for(const [path,key] of [[join(shared,'package-lock.json'),'lockSHA256'],[join(binding,'rolldown-binding.wasm32-wasi.wasm'),'wasmSHA256'],[join(binding,'wasi-worker-browser.mjs'),'pthreadSHA256']])if(hash(readFileSync(path))!==inputs[key])throw Error('Pinned resolver input changed: '+path)
if(JSON.parse(readFileSync(join(binding,'package.json'),'utf8')).version!=='1.2.9')throw Error('Expected binding1.2.9')
const built=realpathSync(mkdtempSync(join(tmpdir(),'rolldown-shared-browser-')))
let server:Server,url:string
test.beforeAll(async()=>{
  await build({entryPoints:{owner:resolve('src/compiler/rolldown-parser.ts'),worker:resolve('src/compiler/rolldown-parser.worker.mjs'),pthread:join(binding,'wasi-worker-browser.mjs')},outdir:built,bundle:true,platform:'browser',format:'esm',target:'es2022',nodePaths:[modules],alias:{'@napi-rs/wasm-runtime/runtime.js':join(modules,'@napi-rs/wasm-runtime/runtime.js'),'@napi-rs/wasm-runtime/dist/fs.js':join(modules,'@napi-rs/wasm-runtime/dist/fs.js')}})
  server=createServer((req,res)=>{
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cross-Origin-Resource-Policy','same-origin')
    const path=new URL(req.url!,'http://localhost').pathname
    if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";import {NativeRolldownParser} from "/owner.js";window.sdk=sdk;window.CallableSession=NativeRolldownParser;</script>');return}
    if(path==='/compiler.wasm'){res.setHeader('Content-Type','application/wasm');res.end(wasm);return}
    try{
      const root=path.startsWith('/sdk/')?sdk:built
      if(root===built&&!['/owner.js','/worker.js','/pthread.js'].includes(path))throw Error('Unknown route')
      const file=realpathSync(resolve(root,path.startsWith('/sdk/')?path.slice(5):path.slice(1)))
      if(!file.startsWith(root+sep))throw Error('Outside fixture files')
      res.setHeader('Content-Type',extname(file)==='.wasm'?'application/wasm':'text/javascript');res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${(server.address() as any).port}`
})
test.afterAll(async()=>{if(server)await new Promise<void>(done=>server.close(()=>done()))})

for(const environment of ['client','server','server-cached'])test(`native ${environment} callable resolver preserves synchronous guest callbacks and Node results`,async({page},info)=>{
  const native=spawnSync(process.execPath,[join(shared,'resolve-reference.mjs')],{encoding:'utf8',timeout:30000})
  expect(native.status,native.stderr).toBe(0)
  const reference=JSON.parse(native.stdout)
  const profile=environment==='client'?reference:reference.server
  const selectedDescriptor=environment==='server-cached'?reference.update.descriptor:profile.descriptor
  const hookProcess=spawnSync(process.execPath,[join(here,'hook-reference.mjs'),JSON.stringify(selectedDescriptor),reference.project+'/src/main.js'],{encoding:'utf8',timeout:30000})
  expect(hookProcess.status,hookProcess.stderr).toBe(0)
  const hookReference=JSON.parse(hookProcess.stdout)
  const expectedUpdate=environment==='server-cached'?{before:reference.update.before,after:reference.update.afterWatch}:reference.updates[environment]
  const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value).split(reference.project).join('/project'))
  const referenceHashes=Object.fromEntries(['resolve-reference.mjs','resolve-cases.mjs','resolve-callback.mjs'].map(name=>[name,hash(readFileSync(join(shared,name)))]))
  const workspaceFiles=Object.fromEntries(Object.entries(files as Record<string,string>).map(([path,text])=>['/project/'+path,text]))
  const workspace=new WorkspaceFiles(workspaceFiles)
  for(const [path,target]of Object.entries(symlinks as Record<string,string>))workspace.symlinkSync(target,'/project/'+path)
  const snapshot=workspace.snapshot();workspace.close()
  const snapshotData={...snapshot,files:Object.fromEntries(Object.entries(snapshot.files).map(([path,bytes])=>[path,Array.from(bytes)]))}
  const guestFiles={...workspaceFiles,'/guest.mjs':readFileSync(resolve('tests/fixtures/rolldown-callable-native/guest.mjs'),'utf8'),'/resolve-callback.mjs':readFileSync(join(shared,'resolve-callback.mjs'),'utf8')}
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).CallableSession))
  const result=await page.evaluate(async data=>{
    const state:any=(window as any).callable={callbacks:[]}
    const kernel=new (window as any).sdk.WorkerKernel(data.guestFiles,{maxBytes:64*1024*1024,assetBaseURL:location.origin+'/sdk/runtime/'})
    const child=await kernel.spawn('node',['/guest.mjs'],{lifetime:'session',maxBytes:64*1024*1024,timeoutMs:30000})
    const pending=new Map<number,{resolve(value:unknown):void;reject(error:Error):void}>()
    let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,buffer='',sequence=0
    const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject})
    const drain=(async()=>{try{for(;;){const event=await child.next();if(event?.type==='stdout'){
      buffer+=new TextDecoder().decode(event.bytes)
      for(;;){const newline=buffer.indexOf('\n');if(newline<0)break;const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1)
        if(line==='GUEST_READY'){readyResolve();continue}
        const reply=JSON.parse(line),waiter=pending.get(reply.id);pending.delete(reply.id)
        reply.error?waiter?.reject(Error(reply.error)):waiter?.resolve(reply.kind==='undefined'?undefined:reply.value)
      }
    }else if(!event||event.type==='exit'){throw Error('Guest callback process exited')}}}catch(error){readyReject(error);for(const waiter of pending.values())waiter.reject(Error(String(error)))}})()
    let session:any
    try{
      await ready
      const snapshot={...data.snapshot,files:Object.fromEntries(Object.entries(data.snapshot.files).map(([path,bytes])=>[path,new Uint8Array(bytes)]))}
      session=await (window as any).CallableSession.open({createWorker:()=>new Worker('/worker.js',{type:'module'}),wasmURL:location.origin+'/compiler.wasm',pthreadURL:location.origin+'/pthread.js',policy:{timeoutMs:30000,maxSourceBytes:1024*1024},resolver:{snapshot,maxBytes:1024*1024,maxFiles:128,
        async callback(_handle:number,method:string,args:unknown[]){
          const id=++sequence,reply=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))
          await child.write(JSON.stringify({id,method,args})+'\n')
          const value=await reply;state.callbacks.push({name:method,args,value});return value
        },
      }})
      const handle=await session.createCallable(data.descriptor)
      const parsed=await session.parse('shared.js','export const answer = 42')
      const load=await session.invokeCallable(handle.handle,'load',['/project/src/main.js'])
      const transform=await session.invokeCallable(handle.handle,'transform',['export const answer = 42','/project/src/main.js',{moduleType:'js'}])
      const hookResults={load:load===undefined?{kind:'undefined'}:{kind:'value',value:load},transform:transform===undefined?{kind:'undefined'}:{kind:'value',value:transform}}
      const results=[]
      for(const item of data.cases)results.push({name:item.name,specifier:item.specifier,result:await session.resolveCallable(handle.handle,item.specifier,'/project/src/main.js',{isEntry:false})})
      const before=results.find(item=>item.specifier===data.update.specifier)!.result
      // Keep the separate guest callback filesystem aligned with the native mirror.
      await kernel.writeText('/project/'+data.update.path,data.update.source)
      const updating=session.updateCallable(handle.handle,'/project/'+data.update.path,new TextEncoder().encode(data.update.source),data.update.event.event)
      // Queue immediately, not after the update response, to exercise ordering.
      const resolving=session.resolveCallable(handle.handle,data.update.specifier,'/project/src/main.js',{isEntry:false})
      const updateAck=await updating,after=await resolving
      state.resources=await session.close()
      return {results,update:{before,after},updateAck,hooks:handle.hooks,parsed,hookResults,callbacks:state.callbacks,resources:state.resources,cleanupStatus:session.cleanupStatus}
    }finally{
      try{if(session)await session.close()}finally{await child.dispose();await drain;kernel.close();await kernel.shutdown;state.ownerClosed=true}
    }
  },{guestFiles,snapshot:snapshotData,descriptor:normalize(selectedDescriptor),cases:profile.results as {name:string;specifier:string}[],update:updateCase as {path:string;source:string;specifier:string;event:{event:'update'}},wasmSHA256:inputs.wasmSHA256}).catch(async error=>{
    const state=await page.evaluate(()=>(window as any).callable)
    await writeFile(info.outputPath('callable-failure.json'),JSON.stringify({error:String(error),state,reference,referenceHashes,sdk,wasmSHA256:inputs.wasmSHA256},null,2))
    throw error
  })
  await writeFile(info.outputPath('callable-evidence.json'),JSON.stringify({result,reference,referenceHashes,environment,descriptor:normalize(selectedDescriptor),sdk,wasmSHA256:inputs.wasmSHA256,scope:'Separate SDK guest callback process, not integrated into the Vite app process; cached profile preserves native stale package exports after watchChange'},null,2))
  expect(result.results).toEqual(normalize(profile.results))
  expect(result.hookResults).toEqual(normalize(hookReference))
  expect(result.update).toEqual(normalize(expectedUpdate))
  expect(result.update.before.id).toBe('/project/'+updateCase.before)
  expect(result.update.after.id).toBe('/project/'+(environment==='server-cached'?updateCase.before:updateCase.after))
  expect(JSON.parse(result.parsed.program).node.type).toBe('Program')
  expect(result.parsed.errors).toEqual([])
  expect(result.cleanupStatus).toBe('acknowledged')
  expect(result.hooks.map((hook:any)=>hook.name)).toEqual(profile.hooks)
  expect(result.hooks.find((hook:any)=>hook.name==='resolveId').order).toEqual(profile.order)
  expect(normalize(result.callbacks)).toEqual(normalize(profile.fixtureTrace))
  expect(result.callbacks.some((call:any)=>call.args[0]==='#local'&&call.value==='./imported.js')).toBe(true)
  expect(result.resources.active).toBe(0)
  expect(result.resources.sharedInitialBytes).toBe(1024*1024*1024)
  expect(result.resources.sharedMaximumBytes).toBe(1280*1024*1024)
})

test('shared native session abort releases callback wait and acknowledges owned pthread cleanup',async({page},info)=>{
  const native=spawnSync(process.execPath,[join(shared,'resolve-reference.mjs')],{encoding:'utf8',timeout:30000})
  expect(native.status,native.stderr).toBe(0)
  const reference=JSON.parse(native.stdout)
  const descriptor=JSON.parse(JSON.stringify(reference.descriptor).split(reference.project).join('/project'))
  const workspace=new WorkspaceFiles(Object.fromEntries(Object.entries(files as Record<string,string>).map(([path,text])=>['/project/'+path,text])))
  const snapshot=workspace.snapshot();workspace.close()
  const serial={...snapshot,files:Object.fromEntries(Object.entries(snapshot.files).map(([path,bytes])=>[path,Array.from(bytes)]))}
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).CallableSession))
  const result=await page.evaluate(async data=>{
    let entered!:()=>void
    const callbackEntered=new Promise<void>(resolve=>{entered=resolve})
    const snapshot={...data.snapshot,files:Object.fromEntries(Object.entries(data.snapshot.files).map(([path,bytes])=>[path,new Uint8Array(bytes)]))}
    const session=await (window as any).CallableSession.open({createWorker:()=>new Worker('/worker.js',{type:'module'}),wasmURL:location.origin+'/compiler.wasm',pthreadURL:location.origin+'/pthread.js',policy:{timeoutMs:30000,maxSourceBytes:1024*1024},resolver:{snapshot,maxBytes:1024*1024,maxFiles:128,callback:()=>{entered();return new Promise(()=>{})}}})
    const handle=await session.createCallable(data.descriptor)
    await session.parse('before.js','export const before = true')
    const resolving=session.resolveCallable(handle.handle,'#local','/project/src/main.js',{isEntry:false}).then(()=>({resolved:true}), (error:Error)=>({error:error.message}))
    await callbackEntered
    session.abort(Error('Owned fixture cancellation'))
    const outcome=await resolving,deadline=performance.now()+5000
    while(session.cleanupStatus==='pending'&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
    return {outcome,status:session.cleanupStatus,resources:session.cleanupResources}
  },{descriptor,snapshot:serial})
  await writeFile(info.outputPath('abort-cleanup.json'),JSON.stringify(result,null,2))
  expect(result.outcome).toEqual({error:'Owned fixture cancellation'})
  expect(result.status).toBe('acknowledged')
  expect(result.resources.active).toBe(0)
})

test('one shared compiler writes native bundles with scoped nested resolution',async({page},info)=>{
  const native=spawnSync(process.execPath,[join(shared,'resolve-reference.mjs')],{encoding:'utf8',timeout:30000})
  expect(native.status,native.stderr).toBe(0)
  const reference=JSON.parse(native.stdout)
  const bundled=spawnSync(process.execPath,[join(here,'bundler-reference.mjs'),reference.project],{encoding:'utf8',timeout:30000})
  expect(bundled.status,bundled.stderr).toBe(0)
  const nativeBundle=JSON.parse(bundled.stdout)
  const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value).split(reference.project).join('/project'))
  const workspace=new WorkspaceFiles(Object.fromEntries(Object.entries(files as Record<string,string>).map(([path,text])=>['/project/'+path,text])))
  const snapshot=workspace.snapshot();workspace.close()
  const serial={...snapshot,files:Object.fromEntries(Object.entries(snapshot.files).map(([path,bytes])=>[path,Array.from(bytes)]))}
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).CallableSession))
  const result=await page.evaluate(async data=>{
    const snapshot={...data.snapshot,files:Object.fromEntries(Object.entries(data.snapshot.files).map(([path,bytes])=>[path,new Uint8Array(bytes)]))}
    let session:any,callable:any,nested=0
    session=await (window as any).CallableSession.open({createWorker:()=>new Worker('/worker.js',{type:'module'}),wasmURL:location.origin+'/compiler.wasm',pthreadURL:location.origin+'/pthread.js',policy:{timeoutMs:30000,maxSourceBytes:1024*1024},resolver:{snapshot,maxBytes:1024*1024,maxFiles:128,
      callback:async()=>undefined,
      async bundlerCallback(id:number,args:any[],scope:number,sync:boolean){
        const method=data.callbacks[id]
        if(method==='resolveId'){
          if(sync)throw Error('Resolve callback must remain asynchronous')
          nested++
          return await session.resolveCallable(callable.handle,args[1],args[2]??'/project/src/main.js',{isEntry:args[3]?.isEntry??false},scope)
        }
        if(method==='deferSyncScanData')return []
        if(['onLog','invalidateJsSideCache'].includes(method))return undefined
        throw Error('Unexpected reference callback: '+method)
      },
    }})
    try{
      callable=await session.createCallable(data.descriptor)
      const handle=await session.createBundler()
      const built=await session.runBundler(handle,'write',data.options,snapshot)
      await session.closeBundler(handle)
      const parsed=await session.parse('after-build.js','export const stillWorking = true')
      const resources=await session.close()
      return {nested,result:built.result,files:Object.fromEntries(Object.entries(built.files).map(([path,bytes])=>[path,Array.from(bytes as Uint8Array)])),previousFiles:built.previousFiles,parsed,resources,cleanup:session.cleanupStatus}
    }finally{if(!session.closed)await session.close()}
  },{snapshot:serial,descriptor:normalize(reference.descriptor),options:normalize(nativeBundle.options),callbacks:nativeBundle.callbacks})
  await writeFile(info.outputPath('bundler-evidence.json'),JSON.stringify({result,nativeBundle,sdk,scope:'Production shared worker transport, owner callbacks, not guest app callback pump'},null,2))
  expect(result.nested).toBeGreaterThan(0)
  expect(Object.fromEntries(Object.entries(result.files).map(([path,bytes])=>[path.slice('/project/out/'.length),bytes]))).toEqual(nativeBundle.files)
  expect(Object.values(result.previousFiles).every(value=>value===null)).toBe(true)
  expect(result.parsed.errors).toEqual([])
  expect(result.resources.active).toBe(0)
  expect(result.resources.sharedInitialBytes).toBe(1024*1024*1024)
  expect(result.cleanup).toBe('acknowledged')
})
