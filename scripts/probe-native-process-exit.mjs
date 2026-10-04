import {readFile} from 'node:fs/promises'
import {resolve,sep} from 'node:path'
import {createServer} from 'vite'
import {chromium,firefox,webkit} from '@playwright/test'
import {nodeCompatibilityVersion,sandboxVersion} from '../src/sandbox/runtime-profile.ts'

const sdk=resolve(process.env.NATIVE_SDK_OUTPUT??'')
if(!process.env.NATIVE_SDK_OUTPUT)throw Error('NATIVE_SDK_OUTPUT is required')
const name=process.env.NATIVE_TEST_BROWSER??'firefox'
const vitePackage=await readFile(resolve('fixtures/native-astro/node_modules/vite/package.json'),'utf8')
const engine={chromium,firefox,webkit}[name]
if(!engine)throw Error(`Unsupported browser: ${name}`)
const host=await createServer({server:{host:'127.0.0.1',port:0,headers:{
  'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
}},plugins:[{name:'process-exit-probe-assets',configureServer(server){
  server.middlewares.use(async(request,response,next)=>{
    const pathname=new URL(request.url??'/','http://localhost').pathname
    if(pathname==='/probe'){
      response.setHeader('Content-Type','text/html')
      response.setHeader('Cross-Origin-Opener-Policy','same-origin')
      response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
      response.end('<!doctype html><title>Process exit probe</title>')
      return
    }
    if(pathname!=='/index.js'&&!pathname.startsWith('/runtime/'))return next()
    const file=resolve(sdk,'.'+pathname)
    if(!file.startsWith(sdk+sep))return next()
    try{
      response.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'text/javascript')
      response.setHeader('Cross-Origin-Opener-Policy','same-origin')
      response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
      response.setHeader('Cross-Origin-Resource-Policy','same-origin')
      response.end(await readFile(file))
    }catch(error){response.statusCode=404;response.end(String(error))}
  })
}}]})
await host.listen()
const browser=await engine.launch({headless:true})
try{
  const page=await browser.newPage()
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
  await page.goto(host.resolvedUrls.local[0]+'probe')
  const result=await page.evaluate(async({nodeCompatibilityVersion,sandboxVersion,vitePackage})=>{
    const {NativeDevServer}=await import('/index.js')
    const server=new NativeDevServer({
      '/app/server.mjs':'export default {fetch(){return new Response("ready")}}',
      '/app/node_modules/vite/package.json':vitePackage,
      '/app/exit.mjs':'Promise.resolve().then(()=>process.exit(0)).catch(()=>process.exit(1))',
      '/app/exit-one.mjs':'process.exit(1)',
      '/app/exit-sync.mjs':'process.exit(0);console.log("unreachable")',
      '/app/rejection.mjs':'Promise.reject(Error("expected")).catch(()=>console.log("handled"))',
      '/app/restart-value.mjs':'import {basename} from "node:path";export const value=basename("/app/restarted")',
      '/app/restart.mjs':'const {createServer}=await import("vite");const server=await createServer({configFile:false,server:{port:4355},optimizeDeps:{noDiscovery:true}});try{await server.listen();if((await server.ssrLoadModule("/app/restart-value.mjs")).value!=="restarted")throw Error("Initial SSR failed");await server.restart();if((await server.ssrLoadModule("/app/restart-value.mjs")).value!=="restarted")throw Error("Restart SSR failed");console.log("restart matched")}finally{await server.close()}',
      '/app/identity.mjs':`if(process.version!==${JSON.stringify('v'+nodeCompatibilityVersion)}||process.versions.node!==${JSON.stringify(nodeCompatibilityVersion)}||process.versions.tanstackSandbox!==${JSON.stringify(sandboxVersion)})throw Error("Runtime identity differs from compatibility profile");console.log("identity matched")`,
    },{workerURL:'/runtime/native/engine.js',entry:'server.mjs',serveFetchEntry:true,installDependencies:false})
    try{
      await server.ready
      const results={}
      for(const name of ['exit','exit-one','exit-sync','rejection','identity','restart']){
        const result=await server.terminalCommand(`node ${name}.mjs`,'/app')
        results[name]={exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr}
      }
      return results
    }finally{await server.dispose()}
  },{nodeCompatibilityVersion,sandboxVersion,vitePackage})
  await page.waitForTimeout(250)
  console.log(JSON.stringify({browser:name,errors,result},null,2))
  if(result.exit?.exitCode!==0||result['exit-one']?.exitCode!==1||result['exit-sync']?.exitCode!==0||
    result['exit-sync']?.stdout||result.rejection?.exitCode!==0||result.rejection?.stdout!=='handled\n'||
    result.identity?.exitCode!==0||result.identity?.stdout!=='identity matched\n'||
    result.restart?.exitCode!==0||!result.restart?.stdout.includes('restart matched\n')||errors.length)
    process.exitCode=1
}finally{
  await browser.close()
  await host.close()
}
