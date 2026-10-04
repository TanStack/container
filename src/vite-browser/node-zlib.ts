import zlib from 'browserify-zlib'
import {Buffer} from 'buffer'
import {brotliCompressBytes,brotliDecompressBytes} from './brotli-codec'

export const gzip=zlib.gzip

type BrotliInput=string|Uint8Array|ArrayBuffer
type BrotliCallback=(error:Error|null,result?:Buffer)=>void

function bytes(input:BrotliInput):Uint8Array{
  if(typeof input==='string')return Buffer.from(input)
  if(input instanceof ArrayBuffer)return new Uint8Array(input)
  if(input instanceof Uint8Array)return input
  throw new TypeError('The "buffer" argument must be a string, Buffer, ArrayBuffer, or Uint8Array')
}

function operation(method:(input:Uint8Array)=>Uint8Array,input:BrotliInput,
  optionsOrCallback:Record<string,unknown>|BrotliCallback,callback?:BrotliCallback):void{
  const options=typeof optionsOrCallback==='function'?undefined:optionsOrCallback
  const done=typeof optionsOrCallback==='function'?optionsOrCallback:callback
  if(typeof done!=='function')throw new TypeError('The "callback" argument must be a function')
  if(options?.params&&Object.keys(options.params as object).length)
    throw new Error('Brotli compression parameters are not supported by this codec')
  queueMicrotask(()=>{
    try{done(null,Buffer.from(method(bytes(input))))}
    catch(error){done(error instanceof Error?error:new Error(String(error)))}
  })
}

export function brotliCompress(input:BrotliInput,callback:BrotliCallback):void
export function brotliCompress(input:BrotliInput,options:Record<string,unknown>,callback:BrotliCallback):void
export function brotliCompress(input:BrotliInput,optionsOrCallback:Record<string,unknown>|BrotliCallback,callback?:BrotliCallback){
  operation(brotliCompressBytes,input,optionsOrCallback,callback)
}

export function brotliDecompress(input:BrotliInput,callback:BrotliCallback):void
export function brotliDecompress(input:BrotliInput,options:Record<string,unknown>,callback:BrotliCallback):void
export function brotliDecompress(input:BrotliInput,optionsOrCallback:Record<string,unknown>|BrotliCallback,callback?:BrotliCallback){
  operation(brotliDecompressBytes,input,optionsOrCallback,callback)
}

export function brotliCompressSync(input:BrotliInput):Buffer{return Buffer.from(brotliCompressBytes(bytes(input)))}
export function brotliDecompressSync(input:BrotliInput):Buffer{return Buffer.from(brotliDecompressBytes(bytes(input)))}

// browserify-zlib implements the deflate family but predates Node's Brotli
// constants. Keep the public constants shape consistent across both runtimes.
export const constants:Readonly<Record<string,number>>=Object.freeze({
  ...Object.fromEntries(Object.entries(zlib).filter(([name])=>name.startsWith('Z_'))),
  BROTLI_DECODE:8,BROTLI_ENCODE:9,
  BROTLI_OPERATION_PROCESS:0,BROTLI_OPERATION_FLUSH:1,
  BROTLI_OPERATION_FINISH:2,BROTLI_OPERATION_EMIT_METADATA:3,
  BROTLI_PARAM_MODE:0,BROTLI_MODE_GENERIC:0,BROTLI_MODE_TEXT:1,
  BROTLI_MODE_FONT:2,BROTLI_DEFAULT_MODE:0,BROTLI_PARAM_QUALITY:1,
  BROTLI_MIN_QUALITY:0,BROTLI_MAX_QUALITY:11,BROTLI_DEFAULT_QUALITY:11,
  BROTLI_PARAM_LGWIN:2,BROTLI_MIN_WINDOW_BITS:10,BROTLI_MAX_WINDOW_BITS:24,
  BROTLI_LARGE_MAX_WINDOW_BITS:30,BROTLI_DEFAULT_WINDOW:22,
  BROTLI_PARAM_LGBLOCK:3,BROTLI_MIN_INPUT_BLOCK_BITS:16,
  BROTLI_MAX_INPUT_BLOCK_BITS:24,BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING:4,
  BROTLI_PARAM_SIZE_HINT:5,BROTLI_PARAM_LARGE_WINDOW:6,
  BROTLI_PARAM_NPOSTFIX:7,BROTLI_PARAM_NDIRECT:8,
})

export default {...zlib,brotliCompress,brotliDecompress,brotliCompressSync,brotliDecompressSync,constants}
