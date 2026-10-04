import {responseMIME} from './response-mime'

const typedArrayTag=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),Symbol.toStringTag)!.get!

/** Consume virtual HTTP bodies directly, preserving the stream's own errors. */
export class StreamResponse extends Response {
  override async arrayBuffer():Promise<ArrayBuffer>{
    if(this.bodyUsed||this.body?.locked)throw new TypeError('Body is unusable')
    if(!this.body)return new ArrayBuffer(0)
    const reader=this.body.getReader(),chunks:Uint8Array[]=[]
    let size=0
    for(;;){
      const {done,value}=await reader.read()
      if(done)break
      if(typedArrayTag.call(value)!=='Uint8Array')throw new TypeError('Body chunk must be a Uint8Array')
      chunks.push(value);size+=value.byteLength
    }
    const bytes=new Uint8Array(size)
    let offset=0
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
    return bytes.buffer
  }
  override async bytes():Promise<Uint8Array<ArrayBuffer>>{return new Uint8Array(await this.arrayBuffer())}
  override async text():Promise<string>{return new TextDecoder().decode(await this.arrayBuffer())}
  override async json():Promise<any>{return JSON.parse(await this.text())}
  override async blob():Promise<Blob>{
    const bytes=await this.arrayBuffer()
    const type=responseMIME(this.headers)
    return new Blob([bytes],{type})
  }
  override async formData():Promise<FormData>{
    const bytes=await this.arrayBuffer()
    const headers=new Headers(this.headers),type=responseMIME(headers)
    if(type)headers.set('content-type',type);else headers.delete('content-type')
    return new Response(bytes,{headers}).formData()
  }
  override clone():StreamResponse{
    const clone=super.clone()
    return new StreamResponse(clone.body,{status:clone.status,statusText:clone.statusText,headers:clone.headers})
  }
}
