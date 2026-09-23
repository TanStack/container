import punycode,{decode,encode,toASCII,toUnicode,ucs2,version} from 'node:punycode'
import {createRequire} from 'node:module'
const required=createRequire(import.meta.url)('node:punycode')
let invalid='';try{decode('%')}catch(error){invalid=error.name}
console.log(JSON.stringify({
  decoded:decode('maana-pta'),encoded:encode('mañana'),ascii:toASCII('mañana.com'),unicode:toUnicode('xn--maana-pta.com'),
  points:ucs2.decode('A💩Z'),joined:ucs2.encode([65,0x1f4a9,90]),version,invalid,
  identity:punycode.decode===decode&&punycode.encode===encode&&punycode.ucs2===ucs2,cjsIdentity:required===punycode,
}))
