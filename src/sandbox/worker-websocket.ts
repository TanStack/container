import type {WorkerKernel} from './kernel'
import {WebSocketFrames,encodeWebSocketFrame,WebSocketProtocolError} from './websocket-frames'
type Socket=Awaited<ReturnType<WorkerKernel['connect']>>
const encoder=new TextEncoder()
const token=/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Host-owned connection to one guest port. The owner supplies the permitted
 * preview origin; guest URLs cannot select another kernel, port or native socket. */
export class WorkerWebSocket {
  #frames:WebSocketFrames
  #closed=false
  #closing=false
  #readPending=false
  #queued=0
  #writes:Promise<void>=Promise.resolve()
  #closeTimer?:ReturnType<typeof setTimeout>
  private constructor(readonly socket:Socket,readonly protocol:string,initial:Uint8Array){
    this.#frames=new WebSocketFrames(async()=>{
      const event=await socket.read()
      if(event?.type==='data')return event.bytes
      if(event?.type==='error')throw new Error('WebSocket socket: '+event.code)
      return null
    },initial)
  }
  static async connect(kernel:Pick<WorkerKernel,'connect'>,port:number,allowedOrigin:string,address:string,protocols:string[]=[]){
    const origin=new URL(allowedOrigin),url=new URL(address)
    const previewAddress=url.host===origin.host&&url.protocol===(origin.protocol==='https:'?'wss:':'ws:')
    const guestLoopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.protocol==='ws:'
    if(!['http:','https:'].includes(origin.protocol)||(!previewAddress&&!guestLoopback)||url.username||url.password||url.hash)throw new Error('WebSocket outside preview origin')
    if(protocols.length>16||new Set(protocols).size!==protocols.length||protocols.some(value=>!token.test(value)||value.length>256))throw new Error('Invalid WebSocket protocols')
    const key=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    const digest=await crypto.subtle.digest('SHA-1',encoder.encode(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))
    const expected=btoa(String.fromCharCode(...new Uint8Array(digest)))
    const requestOrigin=guestLoopback?'http://'+url.host:origin.origin
    const request=encoder.encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${requestOrigin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${protocols.length?'Sec-WebSocket-Protocol: '+protocols.join(', ')+'\r\n':''}\r\n`)
    if(request.length>16384)throw new Error('WebSocket handshake exceeds 16 KiB')
    const socket=await kernel.connect(port)
    let timedOut=false
    const timer=setTimeout(()=>{timedOut=true;void socket.close().catch(()=>{})},10000)
    try{
      await socket.write(request)
      let buffer=new Uint8Array(0),end=-1
      while(end<0){
        const event=await socket.read()
        if(timedOut)throw new Error('WebSocket handshake timed out')
        if(event?.type!=='data')throw new Error('WebSocket handshake transport ended')
        const next=new Uint8Array(buffer.length+event.bytes.length);next.set(buffer);next.set(event.bytes,buffer.length);buffer=next
        for(let i=0;i+3<buffer.length;i++)if(buffer[i]===13&&buffer[i+1]===10&&buffer[i+2]===13&&buffer[i+3]===10){end=i+4;break}
        if((end<0?buffer.length:end)>16384)throw new Error('WebSocket response headers exceed 16 KiB')
      }
      const lines=Array.from(buffer.subarray(0,end-4),byte=>String.fromCharCode(byte)).join('').split('\r\n')
      const statusLine=lines.shift()!
      if(!/^HTTP\/1\.1 101(?: |$)/.test(statusLine))throw new Error('WebSocket handshake rejected: '+statusLine)
      const headers=new Map<string,string>()
      for(const line of lines){
        const colon=line.indexOf(':'),name=line.slice(0,colon).toLowerCase(),value=line.slice(colon+1).trim()
        if(colon<1||!token.test(name)||headers.has(name)||/[^\t\x20-\x7e\x80-\xff]/.test(value))throw new Error('Invalid WebSocket response header')
        headers.set(name,value)
      }
      const protocol=headers.get('sec-websocket-protocol')??''
      if(headers.get('upgrade')?.toLowerCase()!=='websocket'||!headers.get('connection')?.toLowerCase().split(',').map(x=>x.trim()).includes('upgrade')||headers.get('sec-websocket-accept')!==expected)throw new Error('Invalid WebSocket handshake')
      if(headers.has('sec-websocket-extensions')||(protocols.length?!protocols.includes(protocol):protocol!==''))throw new Error('Unexpected WebSocket negotiation')
      return new WorkerWebSocket(socket,protocol,buffer.slice(end))
    }catch(error){await socket.close().catch(()=>{});throw error}
    finally{clearTimeout(timer)}
  }
  #send(opcode:number,data:Uint8Array){
    if(this.#closed)return Promise.reject(new Error('WebSocket closed'))
    const frame=encodeWebSocketFrame(opcode,data)
    if(this.#queued+frame.length>2*1024*1024)return Promise.reject(new Error('WebSocket output queue exceeds 2 MiB'))
    this.#queued+=frame.length
    const write=this.#writes.then(async()=>{
      for(let offset=0;offset<frame.length;offset+=65536)await this.socket.write(frame.slice(offset,offset+65536))
    }).finally(()=>{this.#queued-=frame.length})
    this.#writes=write.catch(()=>{})
    return write
  }
  send(data:string|Uint8Array){
    if(this.#closing)return Promise.reject(new Error('WebSocket closing'))
    return this.#send(typeof data==='string'?1:2,typeof data==='string'?encoder.encode(data):data)
  }
  async next(){
    if(this.#readPending)throw new Error('A WebSocket read is already pending')
    if(this.#closed)return null
    this.#readPending=true
    try{
      for(let controls=0;controls<1024;controls++){
        const event=await this.#frames.read()
        if(event?.type==='ping'){if(!this.#closing)await this.#send(10,event.data);continue}
        if(event?.type==='pong')continue
        if(event?.type==='close'){
          if(!this.#closing)await this.#send(8,event.data)
          await this.socket.end();await this.dispose();return event
        }
        return event
      }
      throw new WebSocketProtocolError('WebSocket control frame flood',1008)
    }catch(error){await this.dispose();throw error}
    finally{this.#readPending=false}
  }
  async close(code=1000,reason=''){
    if(this.#closed||this.#closing)return
    if(code!==1000&&!(code>=3000&&code<=4999&&Number.isInteger(code)))throw new Error('Invalid client close code')
    const bytes=encoder.encode(reason)
    if(bytes.length>123)throw new Error('WebSocket close reason exceeds 123 bytes')
    const data=new Uint8Array(bytes.length+2);data[0]=code>>>8;data[1]=code&255;data.set(bytes,2)
    this.#closing=true
    this.#closeTimer=setTimeout(()=>{void this.dispose()},5000)
    try{await this.#send(8,data)}catch(error){await this.dispose();throw error}
  }
  async dispose(){
    if(this.#closed)return
    this.#closed=true;clearTimeout(this.#closeTimer)
    await this.socket.close().catch(()=>{})
  }
}
