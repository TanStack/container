export interface EsbuildSessionLimits {
  startupMs:number
  requestMs:number
  maxPacketBytes:number
  maxPending:number
}

/** Observes esbuild 0.28.2 stdio without rewriting bytes. Deadlines measure wall
 * time, including plugin callbacks, not CPU time. Idle sessions have no timer.
 * Packet memory and outstanding requests are bounded, not total browser heap.
 */
export class EsbuildSessionMonitor {
  private closed=false
  private ready=false
  private timer:ReturnType<typeof setTimeout>|undefined
  private startup=performance.now()
  private requests=[new Map<number,number>(),new Map<number,number>()]
  private streams=[this.stream(),this.stream()]
  constructor(private limits:EsbuildSessionLimits,private onError:(error:Error)=>void){
    for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<1||value>2147483647)throw Error('Invalid esbuild session limit')
    this.schedule()
  }
  private stream(){return {header:new Uint8Array(4),used:0,body:null as Uint8Array|null,offset:0,started:null as number|null}}
  feedInput(bytes:Uint8Array){this.feed(0,bytes)}
  feedOutput(bytes:Uint8Array){this.feed(1,bytes)}
  close(){this.closed=true;clearTimeout(this.timer);this.requests.forEach(map=>map.clear());this.streams=[this.stream(),this.stream()]}
  private fail(message:string){if(this.closed)return;this.close();this.onError(Error(message))}
  private feed(direction:number,bytes:Uint8Array){
    if(this.closed)return
    if(this.deadline()<=performance.now()){this.fail('Esbuild session request or startup deadline exceeded');return}
    try{
      const stream=this.streams[direction]
      let offset=0
      while(offset<bytes.length){
        stream.started??=performance.now()
        if(stream.used<4){
          const count=Math.min(4-stream.used,bytes.length-offset)
          stream.header.set(bytes.subarray(offset,offset+count),stream.used);stream.used+=count;offset+=count
          if(stream.used<4)break
          const length=new DataView(stream.header.buffer).getUint32(0,true)
          if(length===0||length>this.limits.maxPacketBytes)throw Error('Esbuild packet size limit')
          stream.body=new Uint8Array(length)
        }
        const body=stream.body!
        const count=Math.min(body.length-stream.offset,bytes.length-offset)
        body.set(bytes.subarray(offset,offset+count),stream.offset);stream.offset+=count;offset+=count
        if(stream.offset===body.length){
          this.packet(direction,body,stream.started)
          stream.used=0;stream.offset=0;stream.body=null;stream.started=null
        }
      }
      this.schedule()
    }catch(error){this.fail(String(error))}
  }
  private packet(direction:number,body:Uint8Array,started:number){
    if(direction===1&&!this.ready){
      if(new TextDecoder().decode(body)!=='0.28.2')throw Error('Unsupported esbuild service version')
      this.ready=true;return
    }
    const packet=inspectPacket(body)
    const requests=this.requests[direction]
    if(packet.isRequest){
      if(packet.command==='watch'||packet.command==='serve')throw Error('Esbuild watch and serve are unsupported by the session deadline policy')
      if(requests.has(packet.id))throw Error('Duplicate esbuild request ID')
      if(this.requests[0].size+this.requests[1].size>=this.limits.maxPending)throw Error('Esbuild pending request limit')
      requests.set(packet.id,started)
    }else if(!this.requests[1-direction].delete(packet.id))throw Error('Unknown esbuild response ID')
  }
  private deadline(){
    let deadline=this.ready?Infinity:this.startup+this.limits.startupMs
    for(const map of this.requests)for(const started of map.values())deadline=Math.min(deadline,started+this.limits.requestMs)
    for(const stream of this.streams)if(stream.started!==null)deadline=Math.min(deadline,stream.started+this.limits.requestMs)
    return deadline
  }
  private schedule(){
    clearTimeout(this.timer)
    if(this.closed)return
    const deadline=this.deadline()
    if(deadline!==Infinity)this.timer=setTimeout(()=>this.fail('Esbuild session request or startup deadline exceeded'),Math.max(0,deadline-performance.now()))
  }
}

// Protocol described by esbuild-wasm 0.28.2 lib/main.js, stdio_protocol.ts.
// Skip payload values instead of copying source files and output buffers.
function inspectPacket(bytes:Uint8Array){
  let offset=0,command:string|undefined
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  const take=(length:number)=>{if(length>bytes.length-offset)throw Error('Invalid esbuild packet');const start=offset;offset+=length;return start}
  const u32=()=>view.getUint32(take(4),true)
  const blob=()=>{const length=u32();return bytes.subarray(take(length),offset)}
  const text=()=>new TextDecoder().decode(blob())
  const visit=(depth:number,capture=false):void=>{
    if(depth>128)throw Error('Esbuild packet nesting limit')
    const tag=bytes[take(1)]
    if(tag===0)return
    if(tag===1){take(1);return}
    if(tag===2){take(4);return}
    if(tag===3||tag===4){blob();return}
    if(tag!==5&&tag!==6)throw Error('Invalid esbuild value')
    const count=u32()
    if(count>bytes.length-offset)throw Error('Invalid esbuild value count')
    for(let index=0;index<count;index++){
      const key=tag===6?text():undefined
      if(capture&&key==='command'){
        if(bytes[take(1)]!==3)throw Error('Invalid esbuild command')
        command=text()
      }else visit(depth+1)
    }
  }
  const header=u32();visit(0,true)
  if(offset!==bytes.length)throw Error('Invalid esbuild packet length')
  return {id:header>>>1,isRequest:(header&1)===0,command}
}
