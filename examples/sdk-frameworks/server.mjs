import {createServer} from 'node:http'
import {mkdtempSync,readFileSync,realpathSync} from 'node:fs'
import {dirname,join,resolve,sep,extname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {prepareRuntimeAssets,readPreviewHostHostingContract,readRuntimeProfileManifest} from '@tanstack/browser-sandbox-experimental/assets'
import {resolveSDKRuntimeProfile} from '@tanstack/browser-sandbox-experimental'
import {examplePorts,listen,closeServer} from './host.mjs'

const here=dirname(fileURLToPath(import.meta.url))
const packageRoot=dirname(fileURLToPath(import.meta.resolve('@tanstack/browser-sandbox-experimental')))
const manifest=readRuntimeProfileManifest()
const runtimes={vite:resolveSDKRuntimeProfile(manifest,'vite')}
try{runtimes.start=resolveSDKRuntimeProfile(manifest,'tanstack-start')}catch(error){runtimes.start={error:error instanceof Error?error.message:String(error)}}
const workspace=mkdtempSync(join(tmpdir(),'sdk-frameworks-host-'))
const deployment=await prepareRuntimeAssets(join(workspace,'deployment'))
const runtime=deployment.runtimeDirectory
const hosting=readPreviewHostHostingContract()
const mime={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.html':'text/html'}
function sendFile(response,root,path){
  const file=realpathSync(resolve(root,path))
  if(!file.startsWith(realpathSync(root)+sep))throw Error('Not a hosted file')
  response.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store'})
  response.end(readFileSync(file))
}
export async function startExample(options={}){
  const {ownerPort,previewPort}=examplePorts({ownerPort:4175,previewPort:4176},options)
  const preview=createServer((request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname
    const route=hosting.routes.find(route=>route.path===path&&route.method===request.method)
    if(!route){response.writeHead(hosting.fallbackStatus,hosting.fallbackHeaders??{});response.end('No workspace attached');return}
    response.writeHead(200,route.headers)
    response.end(readFileSync(join(deployment.previewHostDirectory,route.file)))
  })
  const previewOrigin=await listen(preview,previewPort)
  const owner=createServer((request,response)=>{
    if(!runtimes.start.error)for(const [name,value] of Object.entries(runtimes.start.ownerHeaders))response.setHeader(name,value)
    try{
      const path=new URL(request.url,'http://localhost').pathname
      if(request.method!=='GET'){response.writeHead(405);response.end();return}
      if(path==='/config.json'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({previewOrigin,runtimes}));return}
      if(path.startsWith('/runtime/'))return sendFile(response,runtime,decodeURIComponent(path.slice(9)))
      if(path==='/sdk/kernel-host.html'||path==='/sdk/kernel-host.js')return sendFile(response,deployment.directory,path.slice(5))
      if(path.startsWith('/sdk/runtime/'))return sendFile(response,runtime,decodeURIComponent(path.slice(13)))
      if(path.startsWith('/sdk/'))return sendFile(response,packageRoot,decodeURIComponent(path.slice(5)))
      if(path==='/'||path==='/client.js'||path==='/scripts.mjs'||path==='/ports.mjs'||path==='/projects.json')return sendFile(response,here,path==='/'?'index.html':path.slice(1))
      response.writeHead(404);response.end()
    }catch{response.writeHead(404);response.end()}
  })
  try{
    const ownerOrigin=await listen(owner,ownerPort)
    return {ownerOrigin,previewOrigin,preparedAssets:deployment,close:()=>Promise.all([owner,preview].map(closeServer))}
  }catch(error){await closeServer(preview);throw error}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const example=await startExample({ownerPort:process.env.OWNER_PORT,previewPort:process.env.PREVIEW_PORT})
  console.log(`Open ${example.ownerOrigin}`)
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void example.close().then(()=>process.exit(0))})
}
