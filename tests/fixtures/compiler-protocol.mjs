// Test-only codec for esbuild 0.28.2's stdio protocol. Not a public SDK API.
// Requests below are trusted fixed fixture objects, not arbitrary guest input.
const encoder=new TextEncoder(),decoder=new TextDecoder()
export function encodeRequest(id,value){
  const bytes=[]
  const u32=value=>{for(let i=0;i<4;i++)bytes.push(value>>>(8*i)&255)}
  const data=value=>{u32(value.length);for(const byte of value)bytes.push(byte)}
  const visit=value=>{
    if(value===null){bytes.push(0);return}
    if(typeof value==='boolean'){bytes.push(1,+value);return}
    if(typeof value==='number'){bytes.push(2);u32(value);return}
    if(typeof value==='string'){bytes.push(3);data(encoder.encode(value));return}
    if(value instanceof Uint8Array){bytes.push(4);data(value);return}
    if(Array.isArray(value)){bytes.push(5);u32(value.length);for(const item of value)visit(item);return}
    bytes.push(6);const entries=Object.entries(value);u32(entries.length)
    for(const [key,item]of entries){data(encoder.encode(key));visit(item)}
  }
  u32(0);u32(id<<1);visit(value)
  if(bytes.length>1024*1024)throw Error('Protocol request limit')
  const result=Uint8Array.from(bytes);new DataView(result.buffer).setUint32(0,result.length-4,true);return result
}
export function decodeResponse(bytes){
  let offset=0
  const take=count=>{if(offset+count>bytes.length)throw Error('Incomplete service response');const value=bytes.subarray(offset,offset+count);offset+=count;return value}
  const u32=()=>{const data=take(4);return new DataView(data.buffer,data.byteOffset,4).getUint32(0,true)}
  const data=()=>take(u32())
  const visit=(depth=0)=>{
    if(depth>32)throw Error('Service response nesting limit')
    const type=take(1)[0]
    if(type===0)return null
    if(type===1)return !!take(1)[0]
    if(type===2)return u32()|0
    if(type===3)return decoder.decode(data())
    if(type===4)return data()
    if(type!==5&&type!==6)throw Error('Invalid service response type')
    const count=u32();if(count>65536)throw Error('Service collection limit')
    if(type===5){const result=[];for(let i=0;i<count;i++)result.push(visit(depth+1));return result}
    const result=Object.create(null)
    for(let i=0;i<count;i++){const key=decoder.decode(data());result[key]=visit(depth+1)}return result
  }
  const tag=u32(),value=visit()
  if(offset!==bytes.length||(tag&1)!==1)throw Error('Unexpected service packet')
  return {id:tag>>>1,value}
}
