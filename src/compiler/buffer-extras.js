export function createBufferExtras(Buffer,BlobClass,FileClass,TextDecoderClass,TextEncoderClass,kMaxLength,URLClass,installObjectURLs=false,contextIdentity=0){
  const invalid=value=>Object.assign(new TypeError('The "input" argument must be an instance of Buffer, TypedArray, or DataView. Received '+typeof value),{code:'ERR_INVALID_ARG_TYPE'})
  const bytes=value=>{
    if(value instanceof ArrayBuffer||typeof SharedArrayBuffer==='function'&&value instanceof SharedArrayBuffer)return new Uint8Array(value)
    if(value instanceof Uint8Array)return new Uint8Array(value.buffer,value.byteOffset,value.byteLength)
    throw invalid(value)
  }
  const isAscii=value=>{for(const byte of bytes(value))if(byte>127)return false;return true}
  const isUtf8=value=>{try{new TextDecoderClass('utf-8',{fatal:true}).decode(bytes(value));return true}catch(error){if(error?.code==='ERR_INVALID_ARG_TYPE')throw error;return false}}
  const encoding=value=>{
    if(typeof value!=='string')throw Object.assign(new TypeError('The "encoding" argument must be of type string'),{code:'ERR_INVALID_ARG_TYPE'})
    value=value.toLowerCase().replaceAll('-','')
    if(value==='utf8')return 'utf8'
    if(value==='utf16le'||value==='ucs2')return 'utf16le'
    if(value==='latin1'||value==='binary')return 'latin1'
    if(value==='ascii')return 'ascii'
    throw Object.assign(Error('Unable to transcode Buffer [U_ILLEGAL_ARGUMENT_ERROR]'),{code:'U_ILLEGAL_ARGUMENT_ERROR'})
  }
  const decode=(input,kind)=>{
    const value=bytes(input)
    if(kind==='utf8')return new TextDecoderClass().decode(value)
    if(kind==='utf16le')return new TextDecoderClass('utf-16le').decode(value)
    let text='';for(const byte of value)text+=kind==='ascii'&&byte>127?'\ufffd':String.fromCharCode(byte);return text
  }
  const encode=(text,kind)=>{
    if(kind==='utf8')return Buffer.from(new TextEncoderClass().encode(text))
    if(kind==='utf16le'){const output=Buffer.alloc(text.length*2);for(let i=0;i<text.length;i++)output.writeUInt16LE(text.charCodeAt(i),i*2);return output}
    const output=Buffer.alloc(text.length);for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);output[i]=code<=(kind==='ascii'?127:255)?code:63}return output
  }
  const transcode=(source,fromEncoding,toEncoding)=>{if(!(source instanceof Uint8Array))throw invalid(source);return encode(decode(source,encoding(fromEncoding)),encoding(toEncoding))}
  const kStringMaxLength=536870888
  let resolveObjectURL
  if(installObjectURLs&&BlobClass&&URLClass){
    const registry=new Map();let next=0
    const createObjectURL=blob=>{
      if(!(blob instanceof BlobClass))throw Object.assign(new TypeError('The "obj" argument must be an instance of Blob'),{code:'ERR_INVALID_ARG_TYPE'})
      const suffix=(Number(contextIdentity)>>>0).toString(16).padStart(6,'0').slice(-6)+(++next).toString(16).padStart(6,'0').slice(-6),url='blob:nodedata:00000000-0000-4000-8000-'+suffix
      registry.set(url,blob);return url
    }
    const revokeObjectURL=url=>{if(typeof url==='string')registry.delete(url)}
    Object.defineProperty(URLClass,'createObjectURL',{configurable:true,writable:true,value:createObjectURL})
    Object.defineProperty(URLClass,'revokeObjectURL',{configurable:true,writable:true,value:revokeObjectURL})
    resolveObjectURL=url=>{const blob=typeof url==='string'?registry.get(url):undefined;return blob?new BlobClass([blob],{type:blob.type}):undefined}
  }
  return {Blob:BlobClass,File:FileClass,constants:Object.freeze({MAX_LENGTH:kMaxLength,MAX_STRING_LENGTH:kStringMaxLength}),isAscii,isUtf8,kStringMaxLength,transcode,resolveObjectURL}
}
