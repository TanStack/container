import assert from 'node:assert/strict'
import test from 'node:test'
import {Agent,createServer as nodeServer,get} from 'node:http'
import {Socket} from 'node:net'
import {Module} from 'node:module'
import {fileURLToPath} from 'node:url'
import {dirname,join} from 'node:path'
import {build} from 'esbuild'

// Use the browser's actual Writable implementation, not Node's Writable in
// place of it. Keep real TCP underneath to isolate HTTP close ordering.
const root=fileURLToPath(new URL('..',import.meta.url))
const bundle=await build({absWorkingDir:root,entryPoints:['src/sandbox/guest-http.js'],
 bundle:true,write:false,format:'cjs',platform:'node',alias:{'node:stream':'stream-browserify'}})
const filename=join(root,'tests','guest-http-final-cancellation-bundle.cjs')
const compiled=new Module(filename)
compiled.filename=filename;compiled.paths=Module._nodeModulePaths(dirname(filename))
compiled._compile(Buffer.from(bundle.outputFiles[0].contents).toString('utf8'),filename)
const variants=[['Node',nodeServer],['browser HTTP facade',compiled.exports.createServer]]

async function listen(server){
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const address=server.address()
 assert.ok(address&&typeof address!=='string')
 return address.port
}

for(const [name,createServer]of variants){
 for(const mode of ['end then socket destroy','socket destroy then end','end then close all connections']){
  test(name+': '+mode+' does not write a final chunk to a closed socket',async()=>{
   const responseErrors=[],socketErrors=[],events=[]
   let complete,timer
   const closed=new Promise(resolve=>{complete=resolve})
   const server=createServer((req,res)=>{
    req.socket.on('error',error=>socketErrors.push(error.code))
    res.on('error',error=>responseErrors.push(error.code))
    res.on('finish',()=>events.push('finish'))
    res.on('close',()=>{events.push('close');complete()})
    if(mode==='socket destroy then end'){req.socket.destroy();res.end()}
    else {res.end();if(mode==='end then close all connections')server.closeAllConnections();else req.socket.destroy()}
   })
   const port=await listen(server),socket=new Socket()
   socket.on('error',()=>{})
   try{
    await new Promise(resolve=>socket.connect(port,'127.0.0.1',resolve))
    socket.write('GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n')
    await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Response close timed out')),1000)})])
    // The browser Writable queues its final step. Let it run after close,
    // so a late error or an incorrect finish cannot escape the assertion.
    await new Promise(resolve=>setTimeout(resolve,20))
    assert.deepEqual(responseErrors,[])
    assert.deepEqual(socketErrors,[])
    assert.equal(events.filter(event=>event==='close').length,1)
    assert.equal(events.indexOf('close'),events.length-1,'A response cannot finish after close')
    if(mode==='socket destroy then end')assert.deepEqual(events,['close'])
   }finally{
    clearTimeout(timer);socket.destroy();server.closeAllConnections()
    await new Promise(resolve=>server.close(resolve))
   }
  })
 }
 test(name+': a healthy chunked response still finishes and sends its trailers',async()=>{
  const events=[],errors=[]
  const server=createServer((_req,res)=>{
   res.on('error',error=>errors.push(error.code))
   res.on('finish',()=>events.push('finish'));res.on('close',()=>events.push('close'))
   res.setHeader('Trailer','X-Complete');res.addTrailers({'X-Complete':'yes'})
   res.write('first');res.end('second')
  })
  const port=await listen(server)
  try{
   const received=await new Promise((resolve,reject)=>{
    get('http://127.0.0.1:'+port+'/',{agent:false},response=>{
     let text=''
     response.on('data',bytes=>{text+=bytes})
     response.on('error',reject)
     response.on('end',()=>resolve({status:response.statusCode,text,trailers:response.trailers}))
    }).on('error',reject)
   })
   assert.deepEqual(received,{status:200,text:'firstsecond',trailers:{'x-complete':'yes'}})
   assert.deepEqual(errors,[]);assert.deepEqual(events,['finish','close'])
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
 })
 test(name+': completed responses release their socket without closing a keep-alive connection',async()=>{
  const closes=[],connections=new Set(),agent=new Agent({keepAlive:true})
  const server=createServer((req,res)=>{
   connections.add(req.socket)
   res.once('close',()=>closes.push({destroyed:res.destroyed,socket:res.socket}))
   res.setHeader('Content-Length','3');res.end('yes')
  })
  const port=await listen(server)
  try{
   for(let index=0;index<2;index++){
    const body=await new Promise((resolve,reject)=>{
     get('http://127.0.0.1:'+port+'/',{agent},response=>{
      let text='';response.on('data',bytes=>{text+=bytes})
      response.on('error',reject);response.on('end',()=>resolve(text))
     }).on('error',reject)
    })
    assert.equal(body,'yes')
   }
   assert.equal(connections.size,1)
   assert.deepEqual(closes,[{destroyed:true,socket:null},{destroyed:true,socket:null}])
  }finally{agent.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
 })
}
