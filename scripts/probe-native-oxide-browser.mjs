import {build} from 'esbuild'
import {createServer} from 'node:http'
import {copyFile,mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,join,resolve} from 'node:path'
import {chromium,firefox,webkit} from '@playwright/test'

const packageRoot=process.env.OXIDE_BROWSER_PACKAGE_ROOT
if(!packageRoot)throw Error('Set OXIDE_BROWSER_PACKAGE_ROOT to the extracted official WASM package')
const sourceRoot=process.env.OXIDE_PROBE_SOURCE_ROOT
const probePaths=process.env.OXIDE_PROBE_FILES?.split(',')??[
  'src/routeTree.gen.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx',
]
const sourceVariant=process.env.OXIDE_PROBE_VARIANT??'raw'
const preloadWorkers=process.env.OXIDE_PRELOAD_WORKERS==='1'
const probeFiles=sourceRoot?await Promise.all(probePaths.map(async path=>{
  const source=await readFile(join(sourceRoot,path),'utf8')
  const content=sourceVariant==='single-line'?source.replace(/\s*\n\s*/g,' '):
    sourceVariant==='jsx-only'?source.slice(source.indexOf('<div'),source.indexOf('</div>')+'</div>'.length):source
  return {path,content,extension:path.split('.').pop()}
})):[]
const output=await mkdtemp(join(tmpdir(),'native-oxide-probe-'))
await build({
  entryPoints:{oxide:resolve(packageRoot,'tailwindcss-oxide.wasi-browser.js'),
    'wasi-worker-browser':resolve(packageRoot,'wasi-worker-browser.mjs')},
  outdir:output,
  outExtension:{'.js':'.mjs'},
  bundle:true,
  splitting:true,
  platform:'browser',
  format:'esm',
  target:'es2022',
  nodePaths:[resolve(packageRoot,'node_modules')],
  plugins:process.env.OXIDE_PRELOAD_WORKERS==='1'?[{name:'oxide-preloaded-workers',setup(bundler){
    bundler.onLoad({filter:/tailwindcss-oxide\.wasi-browser\.js$/},async args=>{
      let contents=await readFile(args.path,'utf8')
      contents=contents.replace('instantiateNapiModuleSync as __emnapiInstantiateNapiModuleSync',
        'instantiateNapiModule as __emnapiInstantiateNapiModule')
      contents=contents.replace('__emnapiInstantiateNapiModuleSync(__wasmFile, {',
        'await __emnapiInstantiateNapiModule(__wasmFile, {')
      contents=contents.replace('asyncWorkPoolSize: 4,',
        'asyncWorkPoolSize: 4,\n  reuseWorker: { size: 4, strict: true },')
      if(contents.includes('__emnapiInstantiateNapiModuleSync')||!contents.includes('reuseWorker: { size: 4, strict: true }'))
        throw Error('Pinned Oxide browser binding did not match preloading probe')
      return {contents,loader:'js',resolveDir:resolve(packageRoot)}
    })
  }}]:[],
  logLevel:'warning',
})
await copyFile(resolve(packageRoot,'tailwindcss-oxide.wasm32-wasi.wasm'),join(output,'tailwindcss-oxide.wasm32-wasi.wasm'))

const server=createServer(async(req,res)=>{
  const path=new URL(req.url??'/', 'http://localhost').pathname
  res.setHeader('Cross-Origin-Opener-Policy','same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
  res.setHeader('Cross-Origin-Resource-Policy','same-origin')
  if(path==='/'){
    res.setHeader('Content-Type','text/html')
    res.end('<!doctype html><title>Oxide browser probe</title>')
    return
  }
  if(path==='/scan-worker.mjs'){
    res.setHeader('Content-Type','text/javascript')
    res.end(`onmessage=async event=>{
      try{
        const module=await import('./oxide.mjs')
        const scanner=new module.Scanner({sources:[]})
        const results=[]
        for(const file of event.data){
          const candidates=scanner.scanFiles([{content:file.content,extension:file.extension}])
          results.push({path:file.path,count:candidates.length,blue:candidates.includes('text-blue-600')})
        }
        postMessage({results})
      }catch(error){postMessage({error:String(error),stack:error?.stack})}
    }`)
    return
  }
  if(path!==`/${basename(path)}`){res.writeHead(404).end();return}
  try{
    const file=await readFile(join(output,basename(path)))
    res.setHeader('Content-Type',path.endsWith('.wasm')?'application/wasm':'text/javascript')
    res.end(file)
  }catch{res.writeHead(404).end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`
try{
  for(const browserType of [chromium,firefox,webkit].filter(browser=>!process.env.OXIDE_PROBE_BROWSER||browser.name()===process.env.OXIDE_PROBE_BROWSER)){
    const browser=await browserType.launch({headless:true})
    try{
      const page=await browser.newPage()
      page.on('console',message=>{if(message.type()==='error')console.log(browserType.name(),'console',message.text())})
      page.on('pageerror',error=>console.log(browserType.name(),'page error',error.message))
      await page.goto(origin)
      const result=await page.evaluate(async({probeFiles,preloadWorkers})=>{
        const isolated=crossOriginIsolated
        try{
          const module=await Promise.race([
            import('/oxide.mjs'),
            new Promise((_,reject)=>setTimeout(()=>reject(Error('Oxide import timed out')),30000)),
          ])
          const scanner=new module.Scanner({sources:[]})
          const candidates=scanner.scanFiles([{content:'<div class="text-red-500">hello</div>',extension:'html'}])
          const afterScan=scanner.scan()
          const tsxCandidates=scanner.scanFiles([{content:'export default () => <div class="p-2 text-blue-600">Hello</div>',extension:'tsx'}])
          const realResults=(preloadWorkers?[]:probeFiles).map(file=>{
            try{
              const candidates=new module.Scanner({sources:[]}).scanFiles([{content:file.content,extension:file.extension}])
              return {path:file.path,count:candidates.length,blue:candidates.includes('text-blue-600')}
            }catch(error){return {path:file.path,error:String(error)}}
          })
          const positionResults=(preloadWorkers?[]:probeFiles).map(file=>{
            try{
              const candidates=new module.Scanner({sources:[]}).getCandidatesWithPositions({content:file.content,extension:file.extension})
              return {path:file.path,count:candidates.length,blue:candidates.some(item=>item.candidate==='text-blue-600')}
            }catch(error){return {path:file.path,error:String(error)}}
          })
          return {isolated,scannerType:typeof module.Scanner,candidates,afterScan,tsxCandidates,
            realResults,positionResults,exportNames:Object.keys(module)}
        }catch(error){return {isolated,error:String(error),stack:error?.stack}}
      },{probeFiles,preloadWorkers})
      console.log(browserType.name(),JSON.stringify(result))
      if(probeFiles.length){
        const workerResult=await page.evaluate(files=>new Promise(resolve=>{
          const worker=new Worker('/scan-worker.mjs',{type:'module'})
          const timer=setTimeout(()=>{worker.terminate();resolve({error:'Oxide worker scan timed out'})},10000)
          worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data)}
          worker.onerror=event=>{clearTimeout(timer);worker.terminate();resolve({error:event.message})}
          worker.postMessage(files)
        }),probeFiles)
        console.log(browserType.name(),'worker',JSON.stringify(workerResult))
      }
    }finally{await browser.close()}
  }
}finally{await new Promise(resolve=>server.close(resolve))}
