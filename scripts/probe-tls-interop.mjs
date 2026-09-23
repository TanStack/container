import {readFileSync,writeFileSync} from 'node:fs'
import {Duplex} from 'node:stream'
import tls from 'node:tls'
import assert from 'node:assert/strict'
import {setImmediate} from 'node:timers/promises'
import {createHash} from 'node:crypto'
import create from '../public/tls-probe/tls.mjs'
import {build as bundle} from 'esbuild'

const build=JSON.parse(readFileSync('public/tls-probe/build.json'))
const owned=process.argv.includes('--owned')
const runtime=owned?JSON.parse(readFileSync('public/tls-runtime/build.json')):undefined
let TLSBackend,createOwned
if(owned){
  const compiled=await bundle({entryPoints:['src/sandbox/tls-backend.ts'],bundle:true,write:false,platform:'node',format:'esm',target:'es2022'})
  ;({TLSBackend}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64')))
  createOwned=(await import('../public/tls-runtime/tls.mjs')).default
}
const fixture=name=>readFileSync(build.directory+'/'+name)
const ca=fixture('ca.pem'),cert=fixture('server.pem'),key=fixture('server-key.pem')
const query=Buffer.from('GET /answer HTTP/1.1\r\nHost: localhost\r\n\r\n')
const answer=Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n42')
const pending=result=>result===1||result===-0x6900||result===-0x6880||result===-0x7000

async function createPeer(server,version){
  if(owned){
    const backend=new TLSBackend(()=>createOwned({wasmBinary:readFileSync('public/tls-runtime/tls.wasm')}),1)
    await backend.createOwner(1,{maxBytes:2097152})
    let id
    try{id=backend.open(1,{server,ca,cert:server?cert:undefined,key:server?key:undefined,servername:server?'':'localhost',minVersion:version,maxVersion:version})}
    catch(error){await backend.closeOwner(1);throw error}
    return {step:()=>backend.step(1,id),feed:bytes=>backend.feed(1,id,bytes),write:bytes=>backend.write(1,id,bytes),read:()=>backend.read(1,id),drain:()=>backend.drain(1,id),dispose:()=>backend.closeOwner(1)}
  }
  const module=await create({wasmBinary:readFileSync('public/tls-probe/tls.wasm')})
  const buffer=module._malloc(65536);assert.ok(buffer)
  const code=module._tls_peer_open(server?1:0,version)
  if(code){module._tls_peer_destroy();module._free(buffer);assert.equal(code,0)}
  return {
    step:()=>module._tls_peer_handshake(),
    feed:bytes=>{module.HEAPU8.set(bytes,buffer);return module._tls_peer_feed(buffer,bytes.length)},
    write:bytes=>{module.HEAPU8.set(bytes,buffer);return module._tls_peer_write(buffer,bytes.length)},
    read:()=>{const code=module._tls_peer_read(buffer,65536);return {code,bytes:code>0?module.HEAPU8.slice(buffer,buffer+code):new Uint8Array()}},
    drain:()=>{const length=module._tls_peer_drain(buffer,65536);assert.ok(length>=0);return module.HEAPU8.slice(buffer,buffer+length)},
    dispose:()=>{const remaining=module._tls_peer_destroy();module._free(buffer);assert.equal(remaining,0,'TLS allocations retained after connection disposal')},
  }
}

async function connection(wasmServer,version,fragment){
  const peer=await createPeer(wasmServer,version)
  const incoming=[]
  let failed,nodeSecure=false,nodeReceived=Buffer.alloc(0),guestReceived=Buffer.alloc(0)
  let guestSecure=false,guestWrote=false,nodeWrote=false,nodeProtocol,wireBytes=0
  const transport=new Duplex({read(){},write(chunk,_encoding,callback){incoming.push(Buffer.from(chunk));callback()}})
  const protocol=version===12?'TLSv1.2':'TLSv1.3'
  const options={minVersion:protocol,maxVersion:protocol}
  let socket
  try{
    socket=wasmServer?
      tls.connect({...options,socket:transport,servername:'localhost',ca,rejectUnauthorized:true}):
      new tls.TLSSocket(transport,{isServer:true,secureContext:tls.createSecureContext({...options,key,cert})})
    socket.on('error',error=>{failed=error})
    socket.on(wasmServer?'secureConnect':'secure',()=>{
      nodeSecure=true;nodeProtocol=socket.getProtocol()
      if(wasmServer){
        if(!socket.authorized)failed=Error('Node did not authorize the guest certificate')
        socket.write(query);nodeWrote=true
      }
    })
    socket.on('data',chunk=>{
      nodeReceived=Buffer.concat([nodeReceived,chunk])
      if(!wasmServer&&nodeReceived.length===query.length&&!nodeWrote){socket.write(answer);nodeWrote=true}
    })
    const started=performance.now()
    for(let iteration=0;iteration<100000;iteration++){
      if(failed)throw failed
      if(performance.now()-started>10000)throw Error('TLS interoperability timed out')
      while(incoming.length){
        const bytes=incoming.shift()
        for(let offset=0;offset<bytes.length;offset+=fragment){
          const part=bytes.subarray(offset,offset+fragment)
          assert.equal(peer.feed(part),part.length)
          wireBytes+=part.length
          // Drive reads between fragments instead of handing the C peer a
          // whole TLS flight disguised as fragmented writes.
          if(!guestSecure){const code=peer.step();if(!code)guestSecure=true;else assert.ok(pending(code),'Guest handshake: '+code)}
        }
      }
      if(!guestSecure){const code=peer.step();if(!code)guestSecure=true;else assert.ok(pending(code),'Guest handshake: '+code)}
      if(guestSecure){
        if(!guestWrote&&(!wasmServer||guestReceived.length===query.length)){
          const message=wasmServer?answer:query
          const code=peer.write(message)
          if(!pending(code)){assert.equal(code,message.length);guestWrote=true}
        }
        for(;;){
          const {code,bytes}=peer.read()
          if(pending(code))break
          assert.ok(code>0,'Guest read: '+code)
          guestReceived=Buffer.concat([guestReceived,Buffer.from(bytes)])
        }
      }
      for(;;){
        const bytes=Buffer.from(peer.drain())
        if(!bytes.length)break
        wireBytes+=bytes.length
        for(let offset=0;offset<bytes.length;offset+=fragment)transport.push(bytes.subarray(offset,offset+fragment))
      }
      if(nodeSecure&&guestSecure&&nodeReceived.length===(wasmServer?answer:query).length&&guestReceived.length===(wasmServer?query:answer).length)break
      await setImmediate()
    }
    assert.equal(nodeSecure,true);assert.equal(guestSecure,true)
    assert.equal(nodeProtocol,protocol)
    assert.deepEqual(nodeReceived,wasmServer?answer:query)
    assert.deepEqual(guestReceived,wasmServer?query:answer)
    return {wasmRole:wasmServer?'server':'client',version,fragment,protocol,wireBytes,nodeAuthorized:wasmServer?socket.authorized:undefined,elapsedMs:Math.round(performance.now()-started)}
  }finally{
    socket?.destroy();transport.destroy()
    await peer.dispose()
  }
}
const results=[]
for(const server of [false,true])for(const version of [12,13])for(const fragment of [1,13,16384]){
  try{const result=await connection(server,version,fragment);results.push({passed:true,...result})}
  catch(error){results.push({passed:false,wasmRole:server?'server':'client',version,fragment,error:String(error),stack:error.stack})}
}
const passed=results.filter(result=>result.passed).length
const report={scope:'WASM Mbed TLS and native Node TLS exchange encrypted records over in-memory Duplex streams; no OS sockets or guest kernel integration',backend:owned?'owned':'prototype',node:process.version,openssl:process.versions.openssl,build,runtime,backendSHA256:owned?createHash('sha256').update(readFileSync('src/sandbox/tls-backend.ts')).digest('hex'):undefined,scriptSHA256:createHash('sha256').update(readFileSync('scripts/probe-tls-interop.mjs')).digest('hex'),passed,total:results.length,results}
writeFileSync(owned?'reports/tls-owned-interop.json':'reports/tls-probe-interop.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({passed,total:results.length,results},null,2))
if(passed!==results.length)process.exitCode=1
