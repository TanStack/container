import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'

// A checked source patch, not an edit to node_modules. Refuse dependency drift.
export function guestBufferPlugin(){
  const target=resolve('node_modules/buffer/index.js')
  return {name:'guest-buffer-compatibility',setup(build){
    build.onLoad({filter:/[/\\]string_decoder[/\\]lib[/\\]string_decoder\.js$/},args=>{
      let contents=readFileSync(args.path,'utf8')
      if(createHash('sha256').update(contents).digest('hex')!=='f1d36d47b2c579063392c1a68963467f2d4f51a069af09eb068d974c63ee3b37')throw Error('StringDecoder source changed, review base64url support')
      if(contents.split("case 'base64':").length!==4||contents.split(".toString('base64',").length!==4)throw Error('StringDecoder base64 dispatch changed')
      contents=contents.replaceAll("case 'base64':","case 'base64url':case 'base64':")
      // Preserve the three-byte buffering shared by both base64 alphabets.
      // Buffer performs the alphabet and padding conversion on complete groups
      // and on the final partial group, including fillLast().
      contents=contents.replaceAll(".toString('base64',",".toString(this.encoding,")
      return {contents,loader:'js'}
    })
    build.onLoad({filter:/[/\\]buffer[/\\]index\.js$/},args=>{
      if(args.path!==target)return
      const original=readFileSync(target,'utf8')
      if(createHash('sha256').update(original).digest('hex')!=='c25853fd31addfce188b01061fe85bfe667d5fb6c7a7bbb1c83d0ddfd8627acc')throw Error('Buffer source changed, review its compatibility patches')
      const start=original.indexOf('function utf8Slice (buf, start, end) {')
      const end=original.indexOf('// Based on http://stackoverflow.com/a/22747272/680742',start)
      if(start<0||end<=start)throw Error('Buffer decoder patch boundary is missing')
      let contents=original.slice(0,start)+readFileSync('src/compiler/buffer-utf8-slice.js','utf8')+'\n'+original.slice(end)
      const fromStringLength='  const length = byteLength(string, encoding) | 0\n  let buf = createBuffer(length)'
      if(contents.split(fromStringLength).length!==2)throw Error('Buffer string allocation boundary changed')
      contents=contents.replace(fromStringLength,`  const nativeUTF8 = globalThis.__webContainerHost?.encodeUTF8
  const normalizedEncoding = encoding.toLowerCase()
  if (typeof nativeUTF8 === 'function' && (normalizedEncoding === 'utf8' || normalizedEncoding === 'utf-8')) {
    return fromArrayBuffer(nativeUTF8(string))
  }
${fromStringLength}`)
      const writeStart=contents.indexOf('function utf8Write (buf, string, offset, length) {')
      const writeFunction='function utf8Write (buf, string, offset, length) {\n  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)\n}'
      if(writeStart<0||!contents.includes(writeFunction))throw Error('Buffer UTF-8 writer changed')
      contents=contents.replace(writeFunction,readFileSync('src/compiler/buffer-utf8-write.js','utf8'))
      const utf16WriteFunction='function ucs2Write (buf, string, offset, length) {\n  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)\n}'
      if(contents.split(utf16WriteFunction).length!==2)throw Error('Buffer UTF-16 writer changed')
      contents=contents.replace(utf16WriteFunction,readFileSync('src/compiler/buffer-utf16-write.js','utf8'))
      if(contents.split('utf8ToBytes(string).length').length!==3)throw Error('Buffer UTF-8 length dispatch changed')
      contents=contents.replaceAll('utf8ToBytes(string).length','utf8Encode(string)')
      // The existing base64 decoder already accepts both alphabets. Register
      // base64url for validation, byteLength and writes, but emit its distinct
      // alphabet without padding when converting bytes to text.
      if(contents.split("case 'base64':").length!==5)throw Error('Buffer encoding dispatch changed')
      contents=contents.replaceAll("case 'base64':","case 'base64url':\n    case 'base64':")
      const encode="case 'base64url':\n    case 'base64':\n        return base64Slice(this, start, end)"
      if(!contents.includes(encode))throw Error('Buffer base64 output dispatch is missing')
      contents=contents.replace(encode,"case 'base64url':\n        return base64Slice(this, start, end).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')\n      case 'base64':\n        return base64Slice(this, start, end)")
      const decodedLength='return base64ToBytes(string).length'
      if(contents.split(decodedLength).length!==2)throw Error('Buffer base64 byteLength dispatch changed')
      // Node byteLength estimates from the original text, not the permissively
      // decoded bytes. Buffer.from subsequently slices to the actual write size.
      contents=contents.replace(decodedLength,`{
          let length = string.length
          if (string.charCodeAt(length - 1) === 61) length--
          if (string.charCodeAt(length - 1) === 61) length--
          return Math.floor(length * 3 / 4)
        }`)
      return {contents,loader:'js'}
    })
  }}
}
