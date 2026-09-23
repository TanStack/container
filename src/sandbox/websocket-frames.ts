export class WebSocketProtocolError extends Error {
  constructor(message:string, readonly code=1002){super(message);this.name='WebSocketProtocolError'}
}
export type WebSocketFrameEvent =
  | {type:'text';data:string}
  | {type:'binary'|'ping'|'pong';data:Uint8Array}
  | {type:'close';code:number;reason:string;data:Uint8Array}
export const websocketMessageLimit=1024*1024
const textDecoder=()=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true})
const validCloseCode=(code:number)=>code>=3000&&code<=4999||[1000,1001,1002,1003,1007,1008,1009,1010,1011,1012,1013,1014].includes(code)
function text(bytes:Uint8Array){
  try{return textDecoder().decode(bytes)}catch{throw new WebSocketProtocolError('Invalid WebSocket UTF-8',1007)}
}
function closeFrame(data:Uint8Array):Extract<WebSocketFrameEvent,{type:'close'}>{
  if(data.length===1)throw new WebSocketProtocolError('Truncated WebSocket close code')
  const code=data.length?data[0]*256+data[1]:1005
  if(data.length&&!validCloseCode(code))throw new WebSocketProtocolError('Invalid WebSocket close code')
  return {type:'close',code,reason:text(data.subarray(2)),data}
}

/** Server-to-client frames, no negotiated extensions. One bounded message at a
 * time; control frames can interrupt a fragmented message. The owner supplies
 * pull-driven transport reads and closes the transport on errors. */
export class WebSocketFrames {
  #buffer:Uint8Array
  #offset=0
  #opcode=0
  #parts:Uint8Array[]=[]
  #size=0
  #fragments=0
  #closed=false
  #reading=false
  constructor(readonly nextChunk:()=>Promise<Uint8Array|null>,initial:Uint8Array=new Uint8Array(0)){
    if(initial.length>65536)throw new WebSocketProtocolError('Initial WebSocket chunk exceeds 64 KiB',1009)
    this.#buffer=initial.slice()
  }
  async #take(length:number){
    const output=new Uint8Array(length)
    let offset=0
    while(offset<length){
      if(this.#offset===this.#buffer.length){
        const chunk=await this.nextChunk()
        if(chunk===null)throw new WebSocketProtocolError('WebSocket transport ended before close',1006)
        if(!chunk.length||chunk.length>65536)throw new WebSocketProtocolError('Invalid WebSocket transport chunk',1009)
        this.#buffer=chunk;this.#offset=0
      }
      const count=Math.min(length-offset,this.#buffer.length-this.#offset)
      output.set(this.#buffer.subarray(this.#offset,this.#offset+count),offset)
      offset+=count;this.#offset+=count
    }
    return output
  }
  async read():Promise<WebSocketFrameEvent|null>{
    if(this.#reading)throw new Error('A WebSocket read is already pending')
    if(this.#closed)return null
    this.#reading=true
    try{
      for(;;){
        const header=await this.#take(2),final=Boolean(header[0]&128),opcode=header[0]&15
        if(header[0]&112||header[1]&128)throw new WebSocketProtocolError('Unexpected WebSocket reserved bits or server mask')
        if(![0,1,2,8,9,10].includes(opcode))throw new WebSocketProtocolError('Unknown WebSocket opcode')
        const control=opcode>=8
        let length=header[1]&127
        if(control&&(!final||length>125))throw new WebSocketProtocolError('Invalid WebSocket control frame')
        if(length===126){const extended=await this.#take(2);length=extended[0]*256+extended[1];if(length<126)throw new WebSocketProtocolError('Non-minimal WebSocket length')}
        else if(length===127){
          const extended=await this.#take(8)
          if(extended[0]&128)throw new WebSocketProtocolError('Invalid WebSocket 64-bit length')
          let value=0n;for(const byte of extended)value=value*256n+BigInt(byte)
          if(value<65536n)throw new WebSocketProtocolError('Non-minimal WebSocket length')
          if(value>BigInt(websocketMessageLimit))throw new WebSocketProtocolError('WebSocket frame exceeds 1 MiB',1009)
          length=Number(value)
        }
        if(length>websocketMessageLimit)throw new WebSocketProtocolError('WebSocket frame exceeds 1 MiB',1009)
        if(!control){
          if(opcode===0&&!this.#opcode||opcode!==0&&this.#opcode)throw new WebSocketProtocolError('Invalid WebSocket continuation')
          if(this.#size+length>websocketMessageLimit||++this.#fragments>4096)throw new WebSocketProtocolError('WebSocket message limit exceeded',1009)
        }
        const payload=await this.#take(length)
        if(opcode===8){const event=closeFrame(payload);this.#closed=true;this.#parts=[];this.#buffer=new Uint8Array(0);return event}
        if(opcode===9||opcode===10)return {type:opcode===9?'ping':'pong',data:payload}
        if(opcode)this.#opcode=opcode
        this.#parts.push(payload);this.#size+=length
        if(!final)continue
        const data=new Uint8Array(this.#size);let offset=0
        for(const part of this.#parts){data.set(part,offset);offset+=part.length}
        const type=this.#opcode
        this.#parts=[];this.#size=0;this.#opcode=0;this.#fragments=0
        return type===1?{type:'text',data:text(data)}:{type:'binary',data}
      }
    }catch(error){this.#closed=true;this.#parts=[];this.#buffer=new Uint8Array(0);throw error}
    finally{this.#reading=false}
  }
}

/** Final client frame. Mask entropy is supplied by the browser CSPRNG. */
export function encodeWebSocketFrame(opcode:number,payload:Uint8Array,mask=crypto.getRandomValues(new Uint8Array(4))){
  if(![1,2,8,9,10].includes(opcode))throw new WebSocketProtocolError('Unsupported outgoing WebSocket opcode')
  if(payload.length>websocketMessageLimit||opcode>=8&&payload.length>125)throw new WebSocketProtocolError('Outgoing WebSocket frame too large',1009)
  if(mask.length!==4)throw new Error('WebSocket mask must have four bytes')
  if(opcode===1)text(payload)
  if(opcode===8)closeFrame(payload)
  const length=payload.length,headerLength=length<126?2:length<65536?4:10
  const output=new Uint8Array(headerLength+4+length)
  output[0]=128|opcode;output[1]=128|(length<126?length:length<65536?126:127)
  if(headerLength===4){output[2]=length>>>8;output[3]=length&255}
  if(headerLength===10){let n=BigInt(length);for(let i=9;i>=2;i--){output[i]=Number(n&255n);n>>=8n}}
  output.set(mask,headerLength)
  for(let i=0;i<length;i++)output[headerLength+4+i]=payload[i]^mask[i%4]
  return output
}
