/** Explicit artifact preparation, not transparent execution of the original bytes.
 * Supports one defined, nonshared wasm32 memory and function-only imports.
 * This bounds linear memory only, not browser compilation or JavaScript allocations.
 */
export function applyWasmMemoryPolicy(input:Uint8Array,maxPages:number){
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>65536)throw new RangeError('Expected a wasm32 page budget between 1 and 65536')
  if(!(input instanceof Uint8Array)||input.byteLength>64*1024*1024)throw new RangeError('Expected a compiler artifact no larger than 64 MiB')
  const header=[0,97,115,109,1,0,0,0]
  if(input.length<8||header.some((byte,index)=>input[index]!==byte))throw new Error('Expected WebAssembly version 1')
  let offset=8,end=input.length
  const byte=()=>{if(offset>=end)throw new Error('Incomplete WebAssembly section');return input[offset++]}
  const u32=()=>{
    let result=0
    for(let index=0;index<5;index++){
      const value=byte()
      if(index===4&&value>15)throw new Error('Invalid WebAssembly u32')
      result+=(value&127)*2**(7*index)
      if(!(value&128))return result
    }
    throw new Error('Invalid WebAssembly u32')
  }
  const name=()=>{const length=u32();if(length>end-offset)throw new Error('Incomplete import name');offset+=length}
  let memory:undefined|{start:number;end:number;minPages:number;maxPages:number|null}
  let importsSeen=false
  while(offset<input.length){
    end=input.length
    const start=offset,id=byte(),length=u32()
    if(length>input.length-offset)throw new Error('Incomplete WebAssembly section')
    end=offset+length
    if(id===2){
      if(importsSeen)throw new Error('Duplicate import section')
      importsSeen=true
      const count=u32()
      // Every entry consumes at least two names, a kind and a type index.
      if(count>Math.floor((end-offset)/4))throw new Error('Invalid import count')
      for(let index=0;index<count;index++){
        name();name()
        if(byte()!==0)throw new Error('Only function imports are supported by this compiler policy')
        u32()
      }
      if(offset!==end)throw new Error('Unexpected import section bytes')
    }else if(id===5){
      if(memory)throw new Error('Duplicate memory section')
      if(u32()!==1)throw new Error('Expected exactly one defined memory')
      const flags=u32()
      if(flags!==0&&flags!==1)throw new Error('Only nonshared wasm32 memory is supported')
      const minPages=u32(),originalMax=flags===1?u32():null
      if(minPages>65536||(originalMax!==null&&(originalMax<minPages||originalMax>65536)))throw new Error('Invalid wasm32 memory limits')
      if(minPages>maxPages)throw new RangeError('Compiler minimum memory exceeds owner page budget')
      if(offset!==end)throw new Error('Unexpected memory section bytes')
      memory={start,end,minPages,maxPages:originalMax}
    }
    offset=end
  }
  if(!memory)throw new Error('Expected one defined memory')
  const declaredMaxPages=Math.min(maxPages,memory.maxPages??maxPages)
  const encode=(value:number)=>{const bytes=[];do{const part=value%128;value=Math.floor(value/128);bytes.push(part|(value?128:0))}while(value);return bytes}
  const payload=[1,1,...encode(memory.minPages),...encode(declaredMaxPages)]
  const section=new Uint8Array([5,...encode(payload.length),...payload])
  const bytes=new Uint8Array(input.length-(memory.end-memory.start)+section.length)
  bytes.set(input.subarray(0,memory.start));bytes.set(section,memory.start);bytes.set(input.subarray(memory.end),memory.start+section.length)
  return {bytes,minPages:memory.minPages,originalMaxPages:memory.maxPages,declaredMaxPages,requestedMaxPages:maxPages}
}
