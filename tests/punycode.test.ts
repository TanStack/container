import {expect,test} from 'vitest'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const require=createRequire(import.meta.url),implementation=require('../node_modules/tr46/node_modules/punycode/punycode.js')
test('local pure punycode input covers the bounded Node behavior',()=>{
  expect(implementation.decode('maana-pta')).toBe('mañana');expect(implementation.encode('mañana')).toBe('maana-pta')
  expect(implementation.toASCII('mañana.com')).toBe('xn--maana-pta.com');expect(implementation.toUnicode('xn--maana-pta.com')).toBe('mañana.com')
  expect(implementation.ucs2.decode('A💩Z')).toEqual([65,0x1f4a9,90]);expect(implementation.ucs2.encode([65,0x1f4a9,90])).toBe('A💩Z')
  expect(()=>implementation.decode('%')).toThrow(RangeError)
})
test('punycode shipped-input provenance and notice match the local files',()=>{
  const provenance=JSON.parse(readFileSync('public/kernel-runtime/SHIPPED-INPUTS.json','utf8')),entry=provenance.packages[0]
  const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
  expect(entry).toMatchObject({name:'punycode',version:'2.3.1',license:'MIT',runtimeModule:'node:punycode',compatibilityVersion:'2.1.0'})
  expect(entry.sourceSHA256).toBe(hash(entry.source));expect(entry.licenseSHA256).toBe(hash(entry.licenseFile))
  expect(readFileSync('public/kernel-runtime/THIRD-PARTY-NOTICES.txt','utf8')).toContain('punycode@2.3.1\nMIT\n')
})
