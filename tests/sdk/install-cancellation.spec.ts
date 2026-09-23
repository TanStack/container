import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {npmProject} from '../fixtures/npm-project'

const sdkRoot=realpathSync(process.env.SDK_OUTPUT!)
const manifestSHA256=createHash('sha256').update(readFileSync(resolve(sdkRoot,'manifest.json'))).digest('hex')
const {resolveSDKRuntimeProfile}=await import(pathToFileURL(resolve(sdkRoot,'index.js')).href)
const policy=resolveSDKRuntimeProfile(JSON.parse(readFileSync(resolve(sdkRoot,'manifest.json'),'utf8')),'vite')
let server:Server,ownerURL:string
test.beforeAll(async()=>{
  server=createServer((request,response)=>{
    if(policy.requiresCrossOriginIsolation){
      response.setHeader('Cross-Origin-Opener-Policy','same-origin')
      response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    }
    const path=new URL(request.url!,'http://localhost').pathname
    if(path==='/consumer/'){
      response.setHeader('content-type','text/html')
      response.end('<script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk</script>')
      return
    }
    try{
      if(!path.startsWith('/consumer/vendor/'))throw Error('Outside SDK')
      const file=realpathSync(resolve(sdkRoot,decodeURIComponent(path.slice('/consumer/vendor/'.length))))
      if(!file.startsWith(sdkRoot+sep))throw Error('Outside SDK')
      response.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      response.end(readFileSync(file))
    }catch{response.writeHead(404);response.end()}
  })
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done)})
  ownerURL=`http://127.0.0.1:${(server.address() as {port:number}).port}/consumer/`
})
test.afterAll(async()=>{if(server)await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})

for(const api of ['WorkerKernel','AgentSession'] as const)test(`packaged ${api} install abort cleans up before rejection and permits retry`,async({page,context},info)=>{
  test.setTimeout(60000)
  const fixture=npmProject(),requests:{url:string;held:boolean}[]=[],unexpected:string[]=[]
  let release!:()=>void,started!:()=>void,holding=true,released=false
  const gate=new Promise<void>(resolve=>release=()=>{released=true;resolve()})
  const requested=new Promise<void>(resolve=>started=resolve)
  const evidence:Record<string,unknown>={sdkRoot,manifestSHA256,policy,api,registryTransport:'Fixture tarballs fulfilled locally, first install held until cancellation settles'}
  await context.route('**/*',async route=>{
    const url=route.request().url()
    if(new URL(url).origin===new URL(ownerURL).origin){await route.continue();return}
    const archive=fixture.archives[url]
    if(!archive){unexpected.push(url);await route.abort();return}
    const held=holding;requests.push({url,held})
    if(held){started();await gate}
    // The first requests have been cancelled by the time the gate opens.
    try{await route.fulfill({body:archive,headers:{'access-control-allow-origin':'*'}})}catch(error){if(!held)throw error}
  })
  try{
    await page.goto(ownerURL)
    await page.waitForFunction(()=>Boolean((window as any).sdk))
    if(policy.requiresCrossOriginIsolation)expect(await page.evaluate(()=>crossOriginIsolated)).toBe(true)
    await page.evaluate(async({files,api,options})=>{
      const sdk=(window as any).sdk
      const session=api==='AgentSession'?new sdk.AgentSession(files,options):undefined
      const kernel=session?.kernel??new sdk.WorkerKernel(files,options)
      const controller=new AbortController(),reason=new Error('Packaged install cancelled')
      const state:any=(window as any).installCancellation={kernel,session,controller,reason,before:await kernel.snapshot(),compatibility:sdk.SDK_COMPATIBILITY}
      const operation=session?session.install({},controller.signal):kernel.install({},controller.signal)
      state.result=operation.then(()=>({unexpectedSuccess:true}),async(error:unknown)=>({
        message:String(error),sameReason:error===reason,resources:await kernel.resources(),snapshot:await kernel.snapshot(),
      }))
    },{files:fixture.files,api,options:policy.kernelOptions})
    await requested
    const cancelled=await page.evaluate(async()=>{
      const state=(window as any).installCancellation
      state.controller.abort(state.reason)
      const result=await state.result
      const normalize=(snapshot:any)=>JSON.stringify({
        ...snapshot,files:Object.fromEntries(Object.entries(snapshot.files).sort(([a],[b])=>a.localeCompare(b)).map(([path,bytes])=>[path,Array.from(bytes as Uint8Array)])),
      })
      return {...result,workspaceUnchanged:normalize(state.before)===normalize(result.snapshot),compatibility:state.compatibility}
    })
    evidence.cancelled=cancelled
    expect(released,'install must reject after cleanup without waiting for held responses').toBe(false)
    expect(cancelled.unexpectedSuccess).toBeUndefined()
    expect(cancelled.sameReason).toBe(true)
    expect(cancelled.message).toContain('Packaged install cancelled')
    expect(cancelled.workspaceUnchanged).toBe(true)
    expect(cancelled.resources).toMatchObject({installing:false,fileSessions:0,processes:{active:0}})
    expect(cancelled.compatibility.apiVersion).toBeGreaterThanOrEqual(3)
    holding=false;release()
    const recovery=await page.evaluate(async()=>{
      const state=(window as any).installCancellation,{kernel,session}=state
      const install=await(session?session.install({}):kernel.install())
      const execution=await kernel.runModule('/entry.cjs',{guestWasm:true})
      return {installed:install.installed,execution,resources:await kernel.resources()}
    })
    evidence.recovery=recovery
    expect(recovery.installed).toBe(3)
    expect(recovery.execution.exitCode,recovery.execution.stderr).toBe(0)
    expect(recovery.execution.stdout).toBe('42 1\n')
    expect(recovery.resources).toMatchObject({installing:false,fileSessions:0,processes:{active:0}})
    expect(requests.some(request=>request.held)).toBe(true)
    expect(requests.some(request=>!request.held)).toBe(true)
    expect(unexpected).toEqual([])
  }finally{
    release()
    try{await page.evaluate(()=>{const state=(window as any).installCancellation;state?.session?state.session.close():state?.kernel.close();delete (window as any).installCancellation})}catch(error){evidence.cleanupError=String(error)}
    await context.unrouteAll({behavior:'wait'})
    const evidencePath=info.outputPath('packaged-install-cancellation.json')
    await writeFile(evidencePath,JSON.stringify({...evidence,requests,unexpected},null,2))
    await info.attach('packaged-install-cancellation.json',{path:evidencePath,contentType:'application/json'})
  }
})

test('packaged WorkerKernel cancellation is scoped to the rejected concurrent install',async({page,context},info)=>{
  test.setTimeout(60000)
  const fixture=npmProject(),requests:string[]=[],unexpected:string[]=[]
  let release!:()=>void,started!:()=>void,released=false
  const gate=new Promise<void>(resolve=>release=()=>{released=true;resolve()})
  const requested=new Promise<void>(resolve=>started=resolve)
  const evidence:Record<string,unknown>={sdkRoot,manifestSHA256,policy,scope:'Aborting concurrent install B must not cancel held install A'}
  await context.route('**/*',async route=>{
    const url=route.request().url()
    if(new URL(url).origin===new URL(ownerURL).origin){await route.continue();return}
    const archive=fixture.archives[url]
    if(!archive){unexpected.push(url);await route.abort();return}
    requests.push(url);started();await gate
    await route.fulfill({body:archive,headers:{'access-control-allow-origin':'*'}}).catch(()=>{})
  })
  try{
    await page.goto(ownerURL)
    await page.waitForFunction(()=>Boolean((window as any).sdk))
    if(policy.requiresIsolation)expect(await page.evaluate(()=>crossOriginIsolated)).toBe(true)
    await page.evaluate(({files,options})=>{
      const {WorkerKernel}=(window as any).sdk
      const kernel=new WorkerKernel(files,options)
      const state:any=(window as any).scopedInstallCancellation={kernel,firstSettled:false}
      state.first=kernel.install().then((value:any)=>{state.firstSettled=true;return {ok:true,value}},(error:unknown)=>{state.firstSettled=true;return {ok:false,error:String(error)}})
    },{files:fixture.files,options:policy.options})
    await requested
    const beforeRelease=await page.evaluate(async()=>{
      const state=(window as any).scopedInstallCancellation
      const controller=new AbortController(),reason=new Error('Cancel only concurrent install B')
      state.controller=controller
      const second=state.kernel.install({},controller.signal)
      state.second=second.then(()=>({unexpectedSuccess:true}), (error:unknown)=>({message:String(error),sameReason:error===reason}))
      // install() awaits kernel readiness before posting its request. Resume
      // that continuation before aborting, with install A still held on fetch.
      await Promise.resolve()
      controller.abort(reason)
      const rejected=await state.second
      return {rejected,firstSettled:state.firstSettled,resources:await state.kernel.resources()}
    })
    evidence.beforeRelease=beforeRelease
    expect(released).toBe(false)
    expect(beforeRelease.rejected.unexpectedSuccess).toBeUndefined()
    expect(beforeRelease.rejected.sameReason).toBe(true)
    expect(beforeRelease.rejected.message).toContain('Cancel only concurrent install B')
    expect(beforeRelease.firstSettled).toBe(false)
    expect(beforeRelease.resources.installing).toBe(true)
    release()
    const completed=await page.evaluate(async()=>{
      const state=(window as any).scopedInstallCancellation
      const first=await state.first
      if(!first.ok)return {first,execution:null,resources:await state.kernel.resources()}
      const execution=await state.kernel.runModule('/entry.cjs',{guestWasm:true})
      return {first,execution,resources:await state.kernel.resources()}
    })
    evidence.completed=completed
    expect(completed.first.ok,JSON.stringify(completed.first)).toBe(true)
    expect(completed.first.value.installed).toBe(3)
    expect(completed.execution?.exitCode,completed.execution?.stderr).toBe(0)
    expect(completed.execution?.stdout).toBe('42 1\n')
    expect(completed.resources).toMatchObject({installing:false,fileSessions:0,processes:{active:0}})
    expect(unexpected).toEqual([])
  }finally{
    release()
    try{await page.evaluate(async()=>{const state=(window as any).scopedInstallCancellation;if(state){state.controller?.abort();state.kernel.close();await Promise.allSettled([state.first,state.second]);delete (window as any).scopedInstallCancellation}})}catch(error){evidence.cleanupError=String(error)}
    await context.unrouteAll({behavior:'wait'})
    const evidencePath=info.outputPath('packaged-scoped-install-cancellation.json')
    await writeFile(evidencePath,JSON.stringify({...evidence,requests,unexpected},null,2))
    await info.attach('packaged-scoped-install-cancellation.json',{path:evidencePath,contentType:'application/json'})
  }
})
