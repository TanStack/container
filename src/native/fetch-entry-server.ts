import {createServer} from '../sandbox/guest-http.js'
import {IncomingRequest} from '../sandbox/incoming-request'
import * as nodePath from '../vite-browser/node-path'
import {vol} from '../vite-browser/node-fs'
import type {IncomingMessage,ServerResponse} from 'node:http'
import {FetchEntryHandler} from './fetch-entry-handler'

const contentTypes:Record<string,string>={
  '.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon',
}

export function staticResponse(request:Request,root:string):Response|undefined{
  if(request.method!=='GET'&&request.method!=='HEAD')return
  let pathname:string
  try{pathname=decodeURIComponent(new URL(request.url).pathname)}catch{return}
  if(pathname.includes('\0')||pathname.includes('\\'))return
  let file=nodePath.resolve(root,`.${pathname}`)
  if((file===root||file.startsWith(root+'/'))&&vol.existsSync(file)&&vol.statSync(file).isDirectory())
    file=nodePath.join(file,'index.html')
  if(!file.startsWith(root+'/')||!vol.existsSync(file)||!vol.statSync(file).isFile())return
  const bytes=vol.readFileSync(file) as Uint8Array
  return new Response(request.method==='HEAD'?null:new Uint8Array(bytes),{
    headers:{'Content-Type':contentTypes[nodePath.extname(file)]??'application/octet-stream','Content-Length':String(bytes.length)},
  })
}

async function requestBody(request:IncomingMessage):Promise<Uint8Array>{
  const chunks:Uint8Array[]=[]
  let size=0
  for await(const part of request){
    const chunk=part instanceof Uint8Array?part:new Uint8Array(part)
    size+=chunk.length
    if(size>16*1024*1024)throw Error('HTTP request body exceeds 16 MiB')
    chunks.push(chunk)
  }
  const bytes=new Uint8Array(size)
  let offset=0
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return bytes
}

async function sendResponse(response:Response,outgoing:ServerResponse){
  outgoing.statusCode=response.status
  response.headers.forEach((value,name)=>outgoing.setHeader(name,value))
  if(!response.body){outgoing.end();return}
  const reader=response.body.getReader()
  try{
    for(;;){
      const next=await reader.read()
      if(next.done)break
      if(!outgoing.write(next.value))await new Promise<void>(resolve=>outgoing.once('drain',resolve))
    }
    outgoing.end()
  }catch(error){outgoing.destroy(error as Error);throw error}
  finally{reader.releaseLock()}
}

/** Serve a standard fetch export on the browser worker's virtual Node HTTP stack. */
export async function serveFetchEntry(module:Record<string,unknown>,options:{staticRoot?:string}={}):Promise<number>{
  return (await createFetchEntryServer(module,options)).port
}

export async function createFetchEntryServer(module:Record<string,unknown>,options:{staticRoot?:string}={}){
  const handler=new FetchEntryHandler(module)
  const staticRoot=options.staticRoot&&nodePath.resolve('/app',options.staticRoot)
  if(staticRoot&&staticRoot!=='/app'&&!staticRoot.startsWith('/app/'))throw Error('Static root escaped project workspace')
  const server=createServer((incoming:IncomingMessage,outgoing:ServerResponse)=>{
    void (async()=>{
      const host=incoming.headers.host??'127.0.0.1'
      const method=incoming.method??'GET'
      const headers=new Headers()
      for(const [name,value] of Object.entries(incoming.headers)){
        if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(', '):String(value))
      }
      const body=/^(GET|HEAD)$/.test(method)?undefined:await requestBody(incoming)
      const request=new IncomingRequest(`http://${host}${incoming.url??'/'}`,{
        method,headers,body,
      } as RequestInit)
      await sendResponse(staticRoot&&staticResponse(request,staticRoot)||await handler.fetch(request),outgoing)
    })().catch(error=>{
      if(!outgoing.headersSent){outgoing.statusCode=500;outgoing.end('Internal Server Error')}
      else outgoing.destroy(error)
      self.postMessage({type:'native-dev-diagnostic',error:String(error),stack:error instanceof Error?error.stack:undefined})
    })
  })
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject)
    server.listen(0,()=>{server.off('error',reject);resolve()})
  })
  const address=server.address()
  if(!address||typeof address==='string')throw Error('Fetch entry did not publish a virtual port')
  return {port:address.port,replace:(module:Record<string,unknown>)=>handler.replace(module)}
}
