import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'

/** Same isolated, whitelisted candidate assets as the semantic comparison. */
export async function resourceServer(workerSource:string){
  const engine=resolve('public/quickjs-als-generator-resume')
  const metadata=JSON.parse(readFileSync(resolve(engine,'build.json'),'utf8'))
  const wasmSHA256=createHash('sha256').update(readFileSync(resolve(engine,'engine.wasm'))).digest('hex')
  const stageSHA256=createHash('sha256').update(readFileSync('scripts/stage-generator-resume.mjs')).digest('hex')
  const server=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname
    try{
      if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Generator resource probe</title>');return}
      if(path==='/resource.worker.js'){res.setHeader('Content-Type','text/javascript');res.end(workerSource);return}
      if(path==='/ffi.mjs'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync('node_modules/@jitl/quickjs-wasmfile-release-sync/dist/ffi.mjs'));return}
      if(!['/build.json','/core.mjs','/engine.mjs','/engine.wasm'].includes(path))throw Error('Unknown asset')
      res.setHeader('Content-Type',path.endsWith('.wasm')?'application/wasm':path.endsWith('.json')?'application/json':'text/javascript')
      res.end(readFileSync(resolve(engine,path.slice(1))))
    }catch{res.writeHead(404);res.end()}
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  return {metadata,wasmSHA256,stageSHA256,url:`http://127.0.0.1:${(server.address() as {port:number}).port}/`,
    close:()=>new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done())),
  }
}
