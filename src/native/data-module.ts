import {Buffer} from 'buffer'
const prefix='\0native-data-module:'
export function dataModuleId(url:string){return prefix+encodeURIComponent(new URL(url).href)+'.mjs'}
export function dataModuleURL(id:string):string|undefined{
  return id.startsWith(prefix)&&id.endsWith('.mjs')?decodeURIComponent(id.slice(prefix.length,-4)):undefined
}
export function dataModuleSource(url:string){
  const body=new URL(url).href.slice(5).split('#')[0]
  const comma=body.indexOf(',')
  if(comma<0)throw new TypeError('Invalid data module URL')
  const metadata=body.slice(0,comma),mime=metadata.split(';')[0].toLowerCase()
  if(!['text/javascript','application/javascript'].includes(mime))
    throw Object.assign(Error(`Unknown module format: ${mime}`),{code:'ERR_UNKNOWN_MODULE_FORMAT'})
  // Data URLs decode percent escapes as bytes, then decode UTF-8 with
  // replacement characters. decodeURIComponent rejects those valid URLs.
  const encoded=body.slice(comma+1),encoder=new TextEncoder()
  const bytes:number[]=[]
  let start=0
  for(const match of encoded.matchAll(/%([0-9a-f]{2})/gi)){
    for(const byte of encoder.encode(encoded.slice(start,match.index)))bytes.push(byte)
    bytes.push(Number.parseInt(match[1],16))
    start=match.index!+3
  }
  for(const byte of encoder.encode(encoded.slice(start)))bytes.push(byte)
  const payload=new TextDecoder('utf-8',{ignoreBOM:true}).decode(new Uint8Array(bytes))
  return /;base64$/i.test(metadata)?Buffer.from(payload,'base64').toString('utf8'):payload
}
