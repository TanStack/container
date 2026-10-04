import wasmBytes from 'wasm-brotli/wasm_brotli_browser_bg.wasm'

type CodecExports={
  memory:WebAssembly.Memory
  compress:(retptr:number,ptr:number,length:number)=>void
  decompress:(retptr:number,ptr:number,length:number)=>void
  __wbindgen_malloc:(length:number)=>number
  __wbindgen_free:(ptr:number,length:number)=>void
}

let codec:CodecExports|undefined

function getCodec():CodecExports{
  if(codec)return codec
  const heap:unknown[]=Array(36).fill(undefined)
  let next=36
  let instance:CodecExports
  const imports={'./wasm_brotli_browser.js':{
    __wbindgen_string_new(ptr:number,length:number){
      const value=new TextDecoder('utf-8',{fatal:true}).decode(
        new Uint8Array(instance.memory.buffer,ptr,length))
      const index=next++
      heap[index]=value
      return index
    },
    __wbindgen_rethrow(index:number){
      const value=heap[index]
      heap[index]=undefined
      throw value
    },
  }}
  instance=new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(wasmBytes)),imports).exports as CodecExports
  codec=instance
  return instance
}

function run(method:'compress'|'decompress',input:Uint8Array):Uint8Array{
  const wasm=getCodec()
  const ptr=wasm.__wbindgen_malloc(input.length)
  new Uint8Array(wasm.memory.buffer).set(input,ptr)
  const retptr=8
  wasm[method](retptr,ptr,input.length)
  const result=new DataView(wasm.memory.buffer)
  const outputPtr=result.getUint32(retptr,true)
  const outputLength=result.getUint32(retptr+4,true)
  const output=new Uint8Array(wasm.memory.buffer,outputPtr,outputLength).slice()
  wasm.__wbindgen_free(outputPtr,outputLength)
  return output
}

export function brotliCompressBytes(input:Uint8Array):Uint8Array{
  return run('compress',input)
}

export function brotliDecompressBytes(input:Uint8Array):Uint8Array{
  return run('decompress',input)
}
