// `backend` and `core` are initialized by the zlib builtin, inside the guest.
const {binding}=backend
const {Buffer}=core.buffer
const {Transform}=core.stream
const error=(code,message)=>Object.assign(new Error(message),{code})
const invalid=message=>Object.assign(new RangeError(message),{code:'ERR_OUT_OF_RANGE'})
const brotliConstants={BROTLI_DECODE:8,BROTLI_ENCODE:9,BROTLI_OPERATION_PROCESS:0,BROTLI_OPERATION_FLUSH:1,BROTLI_OPERATION_FINISH:2,BROTLI_OPERATION_EMIT_METADATA:3,BROTLI_PARAM_MODE:0,BROTLI_MODE_GENERIC:0,BROTLI_MODE_TEXT:1,BROTLI_MODE_FONT:2,BROTLI_DEFAULT_MODE:0,BROTLI_PARAM_QUALITY:1,BROTLI_MIN_QUALITY:0,BROTLI_MAX_QUALITY:11,BROTLI_DEFAULT_QUALITY:11,BROTLI_PARAM_LGWIN:2,BROTLI_MIN_WINDOW_BITS:10,BROTLI_MAX_WINDOW_BITS:24,BROTLI_LARGE_MAX_WINDOW_BITS:30,BROTLI_DEFAULT_WINDOW:22,BROTLI_PARAM_LGBLOCK:3,BROTLI_MIN_INPUT_BLOCK_BITS:16,BROTLI_MAX_INPUT_BLOCK_BITS:24,BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING:4,BROTLI_PARAM_SIZE_HINT:5,BROTLI_PARAM_LARGE_WINDOW:6,BROTLI_PARAM_NPOSTFIX:7,BROTLI_PARAM_NDIRECT:8,BROTLI_DECODER_RESULT_ERROR:0,BROTLI_DECODER_RESULT_SUCCESS:1,BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT:2,BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT:3,BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION:0,BROTLI_DECODER_PARAM_LARGE_WINDOW:1,BROTLI_DECODER_NO_ERROR:0,BROTLI_DECODER_SUCCESS:1,BROTLI_DECODER_NEEDS_MORE_INPUT:2,BROTLI_DECODER_NEEDS_MORE_OUTPUT:3}
export const constants=Object.freeze({...Object.fromEntries(Object.entries(binding).filter(([name])=>name.startsWith('Z_'))),...brotliConstants,Z_MIN_WINDOWBITS:8,Z_MAX_WINDOWBITS:15,Z_DEFAULT_WINDOWBITS:15,Z_MIN_CHUNK:64,Z_MAX_CHUNK:Infinity,Z_DEFAULT_CHUNK:16384,Z_MIN_MEMLEVEL:1,Z_MAX_MEMLEVEL:9,Z_DEFAULT_MEMLEVEL:8,Z_MIN_LEVEL:-1,Z_MAX_LEVEL:9,Z_DEFAULT_LEVEL:-1})
export const {Z_NO_FLUSH,Z_PARTIAL_FLUSH,Z_SYNC_FLUSH,Z_FULL_FLUSH,Z_FINISH,Z_BLOCK,Z_OK,Z_STREAM_END,Z_NEED_DICT,Z_ERRNO,Z_STREAM_ERROR,Z_DATA_ERROR,Z_MEM_ERROR,Z_BUF_ERROR,Z_VERSION_ERROR,Z_DEFAULT_COMPRESSION,Z_BEST_SPEED,Z_BEST_COMPRESSION,Z_FILTERED,Z_HUFFMAN_ONLY,Z_RLE,Z_FIXED,Z_DEFAULT_STRATEGY,Z_DEFLATED,Z_DEFAULT_WINDOWBITS,Z_DEFAULT_MEMLEVEL,Z_DEFAULT_CHUNK}=constants
export const {BROTLI_DECODE,BROTLI_ENCODE,BROTLI_OPERATION_PROCESS,BROTLI_OPERATION_FLUSH,BROTLI_OPERATION_FINISH,BROTLI_OPERATION_EMIT_METADATA,BROTLI_PARAM_MODE,BROTLI_MODE_GENERIC,BROTLI_MODE_TEXT,BROTLI_MODE_FONT,BROTLI_DEFAULT_MODE,BROTLI_PARAM_QUALITY,BROTLI_MIN_QUALITY,BROTLI_MAX_QUALITY,BROTLI_DEFAULT_QUALITY,BROTLI_PARAM_LGWIN,BROTLI_MIN_WINDOW_BITS,BROTLI_MAX_WINDOW_BITS,BROTLI_LARGE_MAX_WINDOW_BITS,BROTLI_DEFAULT_WINDOW,BROTLI_PARAM_LGBLOCK,BROTLI_MIN_INPUT_BLOCK_BITS,BROTLI_MAX_INPUT_BLOCK_BITS,BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING,BROTLI_PARAM_SIZE_HINT,BROTLI_PARAM_LARGE_WINDOW,BROTLI_PARAM_NPOSTFIX,BROTLI_PARAM_NDIRECT,BROTLI_DECODER_RESULT_ERROR,BROTLI_DECODER_RESULT_SUCCESS,BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT,BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT,BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION,BROTLI_DECODER_PARAM_LARGE_WINDOW,BROTLI_DECODER_NO_ERROR,BROTLI_DECODER_SUCCESS,BROTLI_DECODER_NEEDS_MORE_INPUT,BROTLI_DECODER_NEEDS_MORE_OUTPUT}=constants
export const codes=Object.freeze(Object.fromEntries(['Z_OK','Z_STREAM_END','Z_NEED_DICT','Z_ERRNO','Z_STREAM_ERROR','Z_DATA_ERROR','Z_MEM_ERROR','Z_BUF_ERROR','Z_VERSION_ERROR'].flatMap(name=>[[name,constants[name]],[constants[name],name]])))
const flushTag=Symbol('zlib flush')
const modes={Deflate:binding.DEFLATE,Inflate:binding.INFLATE,Gzip:binding.GZIP,Gunzip:binding.GUNZIP,DeflateRaw:binding.DEFLATERAW,InflateRaw:binding.INFLATERAW,Unzip:binding.UNZIP}
const validFlush=value=>{if(![0,1,2,3,4,5].includes(value))throw invalid('Invalid flush flag');return value}
const number=(value,fallback,min,max,name)=>{value??=fallback;if(!Number.isInteger(value)||value<min||value>max)throw invalid('Invalid '+name);return value}
function bytes(value){
  if(typeof value==='string')return Buffer.from(value)
  if(ArrayBuffer.isView(value))return Buffer.from(value.buffer,value.byteOffset,value.byteLength)
  if(value instanceof ArrayBuffer)return Buffer.from(value)
  throw Object.assign(new TypeError('Expected a string, ArrayBuffer or byte view'),{code:'ERR_INVALID_ARG_TYPE'})
}
function settings(options={}){
  if(!options||typeof options!=='object')throw Object.assign(new TypeError('Expected compression options'),{code:'ERR_INVALID_ARG_TYPE'})
  return {...options,chunkSize:number(options.chunkSize,16384,64,0x7fffffff,'chunkSize'),level:number(options.level,-1,-1,9,'level'),
    memLevel:number(options.memLevel,8,1,9,'memLevel'),strategy:number(options.strategy,0,0,4,'strategy'),
    windowBits:number(options.windowBits,15,0,15,'windowBits'),flush:validFlush(options.flush??0),finishFlush:validFlush(options.finishFlush??4),
    maxOutputLength:number(options.maxOutputLength,core.buffer.kMaxLength,1,core.buffer.kMaxLength,'maxOutputLength'),dictionary:options.dictionary===undefined?undefined:bytes(options.dictionary)}
}
class Engine {
  constructor(mode,options){
    const bits=options.windowBits
    const allowsZero=[binding.INFLATE,binding.GUNZIP,binding.UNZIP].includes(mode)
    if((bits===0&&!allowsZero)||(bits!==0&&bits<(mode===binding.GZIP?9:8)))throw invalid('Invalid windowBits')
    this.options=options;this.bytesWritten=0;this.closed=false;this.failure=null
    this.handle=new binding.Zlib(mode)
    this.handle.onerror=(message,errno)=>{this.failure=Object.assign(Error(message),{errno,code:codes[errno]??'Z_STREAM_ERROR'})}
    this.handle.init(mode===binding.DEFLATERAW&&bits===8?9:bits,options.level,options.memLevel,options.strategy,options.dictionary)
    if(this.failure){this.close();throw this.failure}
  }
  step(input,offset,flag){
    if(this.closed)throw error('ERR_STREAM_DESTROYED','Compression stream is closed')
    const output=Buffer.allocUnsafe(this.options.chunkSize)
    const result=this.handle.writeSync(flag,input,offset,input.length-offset,output,0,output.length)
    if(this.failure)throw this.failure
    const consumed=input.length-offset-result[0];this.bytesWritten+=consumed
    return {output:output.subarray(0,output.length-result[1]),offset:offset+consumed,done:result[1]!==0}
  }
  reset(){if(this.closed)throw error('ERR_STREAM_DESTROYED','Compression stream is closed');this.handle.reset();if(this.failure)throw this.failure;this.bytesWritten=0}
  close(){if(!this.closed){this.closed=true;this.handle.close()}}
}
class Zlib extends Transform {
  constructor(options,mode){
    const selected=settings(options)
    super({...selected,objectMode:false,writableObjectMode:false,readableObjectMode:false})
    this._engine=new Engine(mode,selected);this._options=selected;this._pending=null;this._pumping=false
  }
  get bytesWritten(){return this._engine.bytesWritten}
  get bytesRead(){return this.bytesWritten}
  get _closed(){return this._engine.closed}
  _transform(chunk,_encoding,callback){this._pending={input:chunk,offset:0,flag:chunk[flushTag]??this._options.flush,callback};this._pump()}
  _flush(callback){this._pending={input:Buffer.alloc(0),offset:0,flag:this._options.finishFlush,callback};this._pump()}
  _read(size){super._read(size);this._pump()}
  _pump(){
    if(this._pumping||!this._pending||this.destroyed)return
    this._pumping=true
    try{
      while(this._pending){
        const task=this._pending,result=this._engine.step(task.input,task.offset,task.flag);task.offset=result.offset
        const ready=!result.output.length||this.push(result.output)
        if(this.destroyed||this._pending!==task)break
        if(result.done){this._pending=null;process.nextTick(task.callback);break}
        if(!ready)break
      }
    }catch(error){const task=this._pending;this._pending=null;process.nextTick(()=>task?.callback(error))}
    finally{this._pumping=false}
  }
  _destroy(error,callback){
    const task=this._pending;this._pending=null
    try{this._engine?.close()}catch(failure){error??=failure}
    if(task)process.nextTick(()=>task.callback(error??Object.assign(Error('Compression stream destroyed'),{code:'ERR_STREAM_DESTROYED'})))
    callback(error)
  }
  close(callback){if(callback){if(this.closed)process.nextTick(callback);else this.once('close',callback)}this.destroy()}
  flush(kind,callback){
    if(typeof kind==='function'){callback=kind;kind=Z_FULL_FLUSH}
    kind=validFlush(kind??Z_FULL_FLUSH)
    if(this.writableEnded){if(callback)process.nextTick(callback);return}
    const marker=Buffer.alloc(0);marker[flushTag]=kind;this.write(marker,callback)
  }
  reset(){if(this._pending||this.writableLength)throw error('ERR_INVALID_STATE','Cannot reset with pending writes');this._engine.reset()}
  params(level,strategy,callback){
    number(level,-1,-1,9,'level');number(strategy,0,0,4,'strategy')
    if(level!==this._options.level||strategy!==this._options.strategy)throw error('ERR_UNSUPPORTED_OPERATION','Changing compression parameters mid-stream is not implemented')
    if(callback)process.nextTick(callback)
  }
}
export class Deflate extends Zlib {constructor(options){super(options,modes.Deflate)}}
export class Inflate extends Zlib {constructor(options){super(options,modes.Inflate)}}
export class Gzip extends Zlib {constructor(options){super(options,modes.Gzip)}}
export class Gunzip extends Zlib {constructor(options){super(options,modes.Gunzip)}}
export class DeflateRaw extends Zlib {constructor(options){super(options,modes.DeflateRaw)}}
export class InflateRaw extends Zlib {constructor(options){super(options,modes.InflateRaw)}}
export class Unzip extends Zlib {constructor(options){super(options,modes.Unzip)}}
const constructors={[modes.Deflate]:Deflate,[modes.Inflate]:Inflate,[modes.Gzip]:Gzip,[modes.Gunzip]:Gunzip,[modes.DeflateRaw]:DeflateRaw,[modes.InflateRaw]:InflateRaw,[modes.Unzip]:Unzip}
export const createDeflate=options=>new Deflate(options),createInflate=options=>new Inflate(options),createGzip=options=>new Gzip(options),createGunzip=options=>new Gunzip(options),createDeflateRaw=options=>new DeflateRaw(options),createInflateRaw=options=>new InflateRaw(options),createUnzip=options=>new Unzip(options)
function sync(mode,input,options){
  input=bytes(input);const selected=settings(options),stream=new constructors[mode](selected),engine=stream._engine,chunks=[];let length=0,offset=0
  try{for(;;){const result=engine.step(input,offset,selected.finishFlush);offset=result.offset;length+=result.output.length;if(length>selected.maxOutputLength)throw error('ERR_BUFFER_TOO_LARGE','Compression output exceeds maxOutputLength');chunks.push(result.output);if(result.done)break}
    const buffer=Buffer.concat(chunks,length);return selected.info?{buffer,engine:stream}:buffer
  }finally{engine.close()}
}
function asyncBuffer(Constructor,input,options,callback){
  if(typeof options==='function'){callback=options;options={}}
  if(typeof callback!=='function')throw Object.assign(new TypeError('Expected callback'),{code:'ERR_INVALID_ARG_TYPE'})
  input=bytes(input);const selected=settings(options),stream=new Constructor(selected),chunks=[];let length=0,called=false
  const finish=(error,result)=>{if(called)return;called=true;callback(error,result)}
  stream.on('error',error=>finish(error))
  stream.on('data',chunk=>{length+=chunk.length;if(length>selected.maxOutputLength){stream.destroy(error('ERR_BUFFER_TOO_LARGE','Compression output exceeds maxOutputLength'));return}chunks.push(chunk)})
  stream.on('end',()=>{if(!called){const buffer=Buffer.concat(chunks,length);finish(null,selected.info?{buffer,engine:stream}:buffer)}})
  stream.end(input)
}
export const deflateSync=(input,options)=>sync(modes.Deflate,input,options),inflateSync=(input,options)=>sync(modes.Inflate,input,options),gzipSync=(input,options)=>sync(modes.Gzip,input,options),gunzipSync=(input,options)=>sync(modes.Gunzip,input,options),deflateRawSync=(input,options)=>sync(modes.DeflateRaw,input,options),inflateRawSync=(input,options)=>sync(modes.InflateRaw,input,options),unzipSync=(input,options)=>sync(modes.Unzip,input,options)
export const deflate=(input,options,callback)=>asyncBuffer(Deflate,input,options,callback),inflate=(input,options,callback)=>asyncBuffer(Inflate,input,options,callback),gzip=(input,options,callback)=>asyncBuffer(Gzip,input,options,callback),gunzip=(input,options,callback)=>asyncBuffer(Gunzip,input,options,callback),deflateRaw=(input,options,callback)=>asyncBuffer(DeflateRaw,input,options,callback),inflateRaw=(input,options,callback)=>asyncBuffer(InflateRaw,input,options,callback),unzip=(input,options,callback)=>asyncBuffer(Unzip,input,options,callback)
export function crc32(input,value=0){input=bytes(input);number(value,0,0,0xffffffff,'checksum');return backend.crc32(value,input,input.length,0)>>>0}

let brotliCodec
function getBrotliCodec(){
  if(brotliCodec)return brotliCodec
  const bytes=globalThis.__readBuiltinAsset('brotli-wasm')
  const module=new WebAssembly.Module(bytes)
  const create=method=>{
    const heap=new Array(32).fill(undefined);heap.push(undefined,null,true,false)
    let next=heap.length,wasm
    const add=value=>{if(next===heap.length)heap.push(heap.length+1);const index=next;next=heap[index];heap[index]=value;return index}
    const take=index=>{const value=heap[index];if(index>=36){heap[index]=next;next=index}return value}
    const imports={'./wasm_brotli_browser.js':{
      __wbindgen_string_new(pointer,length){return add(Buffer.from(new Uint8Array(wasm.memory.buffer,pointer,length)).toString())},
      __wbindgen_rethrow(index){throw take(index)},
    }}
    wasm=new WebAssembly.Instance(module,imports).exports
    let memory8=new Uint8Array(wasm.memory.buffer),memory32=new Int32Array(wasm.memory.buffer)
    const refresh=()=>{if(memory8.buffer!==wasm.memory.buffer){memory8=new Uint8Array(wasm.memory.buffer);memory32=new Int32Array(wasm.memory.buffer)}}
    return input=>{
      const pointer=wasm.__wbindgen_malloc(input.length);refresh();memory8.set(input,pointer);wasm[method](8,pointer,input.length);refresh()
      const outputPointer=memory32[2],outputLength=memory32[3],output=Buffer.from(memory8.subarray(outputPointer,outputPointer+outputLength));wasm.__wbindgen_free(outputPointer,outputLength);return output
    }
  }
  return brotliCodec={compress:create('compress'),decompress:create('decompress')}
}
function brotliSettings(options={},compressing=false){
  if(!options||typeof options!=='object')throw Object.assign(new TypeError('Expected compression options'),{code:'ERR_INVALID_ARG_TYPE'})
  const maxOutputLength=number(options.maxOutputLength,core.buffer.kMaxLength,1,core.buffer.kMaxLength,'maxOutputLength')
  if(options.params!==undefined){
    if(!options.params||typeof options.params!=='object')throw Object.assign(new TypeError('Expected Brotli params'),{code:'ERR_INVALID_ARG_TYPE'})
    const supported=compressing?{[BROTLI_PARAM_MODE]:BROTLI_DEFAULT_MODE,[BROTLI_PARAM_QUALITY]:BROTLI_DEFAULT_QUALITY,[BROTLI_PARAM_LGWIN]:BROTLI_DEFAULT_WINDOW}:{}
    for(const [key,value] of Object.entries(options.params))if(Number(key)!==BROTLI_PARAM_SIZE_HINT&&value!==supported[key])throw error('ERR_UNSUPPORTED_OPERATION','This Brotli parameter is not implemented')
  }
  return {...options,maxOutputLength}
}
function brotliSync(input,options,compressing){
  input=bytes(input);const selected=brotliSettings(options,compressing)
  let buffer
  try{buffer=Buffer.from(compressing?getBrotliCodec().compress(input):getBrotliCodec().decompress(input))}catch(cause){if(cause?.code)throw cause;throw Object.assign(Error(String(cause)),{code:'Z_DATA_ERROR',cause})}
  if(buffer.length>selected.maxOutputLength)throw error('ERR_BUFFER_TOO_LARGE','Compression output exceeds maxOutputLength')
  if(!selected.info)return buffer
  const engine={bytesWritten:input.length,closed:true};return {buffer,engine}
}
class Brotli extends Transform {
  constructor(options,compressing){const selected=brotliSettings(options,compressing);super({...selected,objectMode:false,writableObjectMode:false,readableObjectMode:false});this._options=selected;this._compressing=compressing;this._chunks=[];this.bytesWritten=0}
  get bytesRead(){return this.bytesWritten}
  _transform(chunk,_encoding,callback){const copy=Buffer.from(chunk);this._chunks.push(copy);this.bytesWritten+=copy.length;callback()}
  _flush(callback){try{const input=Buffer.concat(this._chunks,this.bytesWritten),output=brotliSync(input,this._options,this._compressing);this._chunks=[];if(output.length)this.push(output);callback()}catch(error){callback(error)}}
  close(callback){if(callback){if(this.closed)process.nextTick(callback);else this.once('close',callback)}this.destroy()}
  flush(kind,callback){if(typeof kind==='function')callback=kind;if(callback)process.nextTick(callback)}
  reset(){if(this.writableLength)throw error('ERR_INVALID_STATE','Cannot reset with pending writes');this._chunks=[];this.bytesWritten=0}
}
export class BrotliCompress extends Brotli {constructor(options){super(options,true)}}
export class BrotliDecompress extends Brotli {constructor(options){super(options,false)}}
export const createBrotliCompress=options=>new BrotliCompress(options),createBrotliDecompress=options=>new BrotliDecompress(options)
export const brotliCompressSync=(input,options)=>brotliSync(input,options,true),brotliDecompressSync=(input,options)=>brotliSync(input,options,false)
export const brotliCompress=(input,options,callback)=>asyncBuffer(BrotliCompress,input,options,callback),brotliDecompress=(input,options,callback)=>asyncBuffer(BrotliDecompress,input,options,callback)
export default {constants,codes,Deflate,Inflate,Gzip,Gunzip,DeflateRaw,InflateRaw,Unzip,BrotliCompress,BrotliDecompress,createDeflate,createInflate,createGzip,createGunzip,createDeflateRaw,createInflateRaw,createUnzip,createBrotliCompress,createBrotliDecompress,deflateSync,inflateSync,gzipSync,gunzipSync,deflateRawSync,inflateRawSync,unzipSync,brotliCompressSync,brotliDecompressSync,deflate,inflate,gzip,gunzip,deflateRaw,inflateRaw,unzip,brotliCompress,brotliDecompress,crc32,...constants}
