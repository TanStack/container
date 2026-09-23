import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {observeSDKEngines} from '../sdk/engine-evidence'

const root=realpathSync(process.env.SDK_OUTPUT!)
const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/project/'+name,readFileSync('fixtures/install-start-wasm/'+name,'utf8')]))
const entries=['react','react-dom','react/jsx-dev-runtime','react/jsx-runtime','react-dom/client','@tanstack/react-store','@tanstack/router-core/isServer','@tanstack/router-core/ssr/client','@tanstack/router-core','seroval']
let owner:Server,ownerURL:string

test.beforeAll(async()=>{
  owner=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname
    if(path==='/app/'){
      res.setHeader('Content-Type','text/html')
      res.end('<script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk;</script>');return
    }
    try{
      if(!path.startsWith('/app/vendor/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice('/app/vendor/'.length))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise<void>((done,reject)=>{owner.once('error',reject);owner.listen(0,'127.0.0.1',done)})
  ownerURL=`http://127.0.0.1:${(owner.address() as {port:number}).port}/app/`
})
test.afterAll(async()=>{if(owner)await new Promise<void>((done,reject)=>owner.close(error=>error?reject(error):done()))})

for(const concurrent of [false,true])test('built SDK prebundles expanded Start dependencies'+(concurrent?' with concurrent transform':''),async({page},info)=>{
  const diagnostics:string[]=[]
  page.on('pageerror',error=>diagnostics.push(error.message))
  await page.goto(ownerURL)
  await page.waitForFunction(()=>Boolean((window as any).sdk))
  const evidence=observeSDKEngines(page,info,root,'quickjs-als-wasm')
  let primaryError:unknown
  try{
    const result=await page.evaluate(async({files,entries,concurrent})=>{
      const {WorkerKernel}=(window as any).sdk
      const state:any=(window as any).prebundleSDK={stage:'install'}
      const kernel=state.kernel=new WorkerKernel(files,{cooperative:false,maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
      state.install=await kernel.install({cwd:'/project',ignoreScripts:true})
      await kernel.writeText('/project/probe.mjs',`
        import {context,transform,stop} from 'esbuild';
        const started=performance.now();
        console.log(JSON.stringify({phase:'imported',ms:0}));
        const ctx=await context({entryPoints:${JSON.stringify(entries)},bundle:true,splitting:true,format:'esm',platform:'browser',target:['chrome107','edge107','firefox104','safari16'],jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},sourcemap:true,metafile:true,write:false,outdir:'/out',ignoreAnnotations:true});
        try{
          console.log(JSON.stringify({phase:'context-ready',ms:performance.now()-started}));
          const build=ctx.rebuild().then(result=>{
            if(!result.outputFiles.length||!Object.keys(result.metafile.inputs).length)throw Error('Empty dependency build');
            console.log(JSON.stringify({phase:'build',ms:performance.now()-started,files:result.outputFiles.length,bytes:result.outputFiles.reduce((n,file)=>n+file.contents.length,0),inputs:Object.keys(result.metafile.inputs).length}));
          });
          ${concurrent?`const transformed=transform('export const value: number = 42',{loader:'ts'}).then(result=>{if(!result.code.includes('42'))throw Error('Incorrect transform');console.log(JSON.stringify({phase:'transform',ms:performance.now()-started}))});await Promise.all([build,transformed]);`:'await build;'}
          console.log('PREBUNDLE_COMPLETE');
        }finally{await ctx.dispose();stop()}
      `)
      state.stage='prebundle'
      state.result=await kernel.runModule('/project/probe.mjs',{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000,profileJobs:false,diagnostics:true})
      state.stage='complete'
      return state.result
    },{files,entries,concurrent})
    const resultPath=info.outputPath('sdk-prebundle-result.json')
    await writeFile(resultPath,JSON.stringify({entries,concurrent,result},null,2))
    await info.attach('sdk-prebundle-result.json',{path:resultPath,contentType:'application/json'})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(result.stdout).toContain('PREBUNDLE_COMPLETE')
    if(concurrent)expect(result.stdout).toContain('"phase":"transform"')
    expect(diagnostics).toEqual([])
  }catch(error){primaryError=error;throw error}
  finally{
    const cleanupErrors:string[]=[]
    try{
      const state=await page.evaluate(()=>{const state=(window as any).prebundleSDK;return {stage:state?.stage,install:state?.install,result:state?.result,operations:state?.kernel?.jobProfile}})
      const diagnosticsPath=info.outputPath('sdk-prebundle-diagnostics.json')
      await writeFile(diagnosticsPath,JSON.stringify({diagnostics,state},null,2))
      await info.attach('sdk-prebundle-diagnostics.json',{path:diagnosticsPath,contentType:'application/json'})
    }catch(error){cleanupErrors.push('diagnostics: '+String(error))}
    try{await page.evaluate(()=>{(window as any).prebundleSDK?.kernel?.close()})}catch(error){cleanupErrors.push('close: '+String(error))}
    try{await evidence.flush()}catch(error){cleanupErrors.push('engine evidence: '+String(error))}
    if(cleanupErrors.length){
      await info.attach('sdk-prebundle-cleanup-errors.json',{body:JSON.stringify(cleanupErrors),contentType:'application/json'})
      if(!primaryError)throw Error(cleanupErrors.join('\n'))
    }
  }
})
