import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {test} from 'node:test'
import assert from 'node:assert/strict'

const source=readFileSync(new URL('../preview-host/websocket.js',import.meta.url),'utf8')
function fixture(){
  const channels=[],listeners=new Map()
  class Port{
    onmessage=null;messages=[];closed=0
    postMessage(data){this.messages.push(data)}
    close(){this.closed++}
    receive(data){this.onmessage?.({data})}
  }
  class Channel{
    port1=new Port();port2=new Port()
    constructor(){channels.push(this)}
  }
  class CloseEvent extends Event{
    constructor(type,options){super(type);Object.assign(this,options)}
  }
  const context={MessageChannel:Channel,EventTarget,Event,MessageEvent,CloseEvent,TextEncoder,URL,DOMException,Blob,ArrayBuffer,Uint8Array,setTimeout,
    location:new URL('https://preview.invalid/'),parent:{postMessage(){}},
    addEventListener(type,callback){listeners.set(type,callback)},
  }
  runInNewContext(source,context,{filename:'preview-host/websocket.js'})
  return {channels,hide(){listeners.get('pagehide')()},connect(){
    const socket=new context.WebSocket('/hmr'),port=channels.at(-1).port1
    return {socket,port}
  }}
}

test('pagehide disposes open and connecting sockets without invoking app reconnect handlers',()=>{
  const f=fixture(),open=f.connect(),connecting=f.connect()
  const queuedDelivery=connecting.port.onmessage
  open.port.receive({type:'open',protocol:'vite-hmr'})
  let appEvents=0
  for(const {socket} of [open,connecting]){
    socket.onclose=()=>{appEvents++}
    socket.onerror=()=>{appEvents++}
    socket.addEventListener('close',()=>{appEvents++})
  }
  f.hide();f.hide()
  queuedDelivery({data:{type:'open',protocol:'vite-hmr'}})
  queuedDelivery({data:{type:'error'}})
  for(const {socket,port} of [open,connecting]){
    assert.equal(socket.readyState,3)
    assert.equal(port.messages.filter(x=>x.type==='detach').length,1)
    assert.equal(port.closed,1)
    assert.equal(port.onmessage,null)
    port.receive({type:'open',protocol:'vite-hmr'})
    port.receive({type:'error'})
    assert.equal(socket.readyState,3)
  }
  assert.equal(appEvents,0)
})

test('ordinary remote close and transport error still reach app listeners exactly once',()=>{
  for(const message of [{type:'close',code:1001,reason:'server stopped',clean:true},{type:'error'}]){
    const f=fixture(),{socket,port}=f.connect(),events=[]
    socket.onclose=event=>events.push(['close',event.code,event.reason,event.wasClean])
    socket.onerror=()=>events.push(['error'])
    port.receive({type:'open',protocol:''})
    port.receive(message);port.receive(message)
    assert.deepEqual(events,message.type==='error'?[['error'],['close',1006,'',false]]:[['close',1001,'server stopped',true]])
    f.hide()
    assert.equal(port.closed,1)
    assert.equal(port.messages.some(x=>x.type==='dispose'),false)
  }
})

test('application close preserves the host handshake and close event',async()=>{
  const f=fixture(),{socket,port}=f.connect(),events=[]
  socket.onclose=event=>events.push(event.code)
  port.receive({type:'open',protocol:''})
  socket.close(3001,'finished')
  await Promise.resolve();await Promise.resolve()
  assert.equal(socket.readyState,2)
  assert.deepEqual(JSON.parse(JSON.stringify(port.messages.at(-1))),{type:'close',code:3001,reason:'finished'})
  port.receive({type:'close',code:3001,reason:'finished',clean:true})
  assert.deepEqual(events,[3001])
  assert.equal(socket.readyState,3)
})

test('pagehide silences an in-flight failed Blob write and queued application close',async()=>{
  const f=fixture(),{socket,port}=f.connect(),events=[]
  let rejectWrite
  class PendingBlob extends Blob{
    arrayBuffer(){return new Promise((_resolve,reject)=>{rejectWrite=reject})}
  }
  socket.onerror=()=>events.push('error')
  socket.onclose=()=>events.push('close')
  port.receive({type:'open',protocol:''})
  socket.send(new PendingBlob(['payload']))
  await Promise.resolve()
  assert.equal(typeof rejectWrite,'function')
  socket.close()
  f.hide()
  rejectWrite(new Error('document ended'))
  await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(events,[])
    assert.equal(port.messages.filter(x=>x.type==='detach').length,1)
  assert.equal(port.messages.some(x=>x.type==='send'||x.type==='close'),false)
})
