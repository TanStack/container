// Exercises the actual pinned Vite createServer API with the existing native
// toolchain adapters. No watch/HMR disabling or successful-server simulation.
import {connectVirtual} from '../vite-browser/engine'
import {resetVolume,writeFileSync} from '../vite-browser/node-fs'
import * as esbuild from 'esbuild-wasm'
import {get} from '../sandbox/guest-http.js'
import {WorkerWebSocket} from '../sandbox/worker-websocket'

self.onmessage=async({data})=>{
  let server:Awaited<ReturnType<typeof import('vite')['createServer']>>|undefined
  let reply:unknown
  try{
    resetVolume(data.files)
    const {createServer}=await import('vite')
    server=await createServer({root:'/app',configFile:false,logLevel:'silent'})
    await server.listen()
    const address=server.httpServer?.address()
    if(!address||typeof address==='string')throw Error('Vite did not publish a virtual port')
    const requestPath=(path:string)=>new Promise<{status:number;body:string}>((resolve,reject)=>{
      get({host:'127.0.0.1',port:address.port,path},(incoming:import('node:http').IncomingMessage)=>{
        const chunks:Uint8Array[]=[]
        incoming.on('data',(chunk:Uint8Array)=>chunks.push(chunk))
        incoming.on('end',()=>resolve({status:incoming.statusCode??0,body:new TextDecoder().decode(Buffer.concat(chunks))}))
        incoming.on('error',reject)
      }).on('error',reject)
    })
    const [html,module]=await Promise.all([requestPath('/'),requestPath('/main.js')])
    const websocket=await WorkerWebSocket.connect({connect:connectVirtual},address.port,
      `http://127.0.0.1:${address.port}`,
      `ws://127.0.0.1:${address.port}/?token=${encodeURIComponent(server.config.webSocketToken)}`,
      ['vite-hmr'])
    const connected=await Promise.race([websocket.next(),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('HMR connect timeout')),3000))])
    writeFileSync('/app/main.js','if(import.meta.hot)import.meta.hot.accept();document.body.textContent="native edited"')
    let edited=await requestPath('/main.js')
    for(let attempt=0;attempt<20&&!edited.body.includes('native edited');attempt++){
      await new Promise(resolve=>setTimeout(resolve,25))
      edited=await requestPath('/main.js')
    }
    const update=await Promise.race([websocket.next(),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('HMR update timeout')),3000))])
    await websocket.dispose()
    reply={result:{listening:true,port:address.port,htmlStatus:html.status,html:html.body.includes('/main.js'),moduleStatus:module.status,module:module.body.includes('native dev'),editedStatus:edited.status,edited:edited.body.includes('native edited'),hmrConnected:connected?.type==='text'&&JSON.parse(connected.data).type==='connected',hmrUpdate:update?.type==='text'?JSON.parse(update.data).type:undefined}}
  }catch(error){reply={error:String(error),stack:error instanceof Error?error.stack:undefined}}
  finally{await server?.close();await esbuild.stop()}
  self.postMessage(reply)
}
