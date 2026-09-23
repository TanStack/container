import {test,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

const {utf8Encode,utf8Write}=runInNewContext(readFileSync('src/compiler/buffer-utf8-write.js','utf8')+';({utf8Encode,utf8Write})')
test('UTF-8 counts and bounded writes match Node across Unicode boundaries',()=>{
  const texts=['','ASCII','é水😀','\uD800','\uDC00','\uD800\uD800x','x\uDC00\uD800','\uDBFF\uDFFF']
  let seed=17
  for(let i=0;i<500;i++){
    let text=''
    for(let j=0;j<12;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=String.fromCharCode(seed&65535)}
    texts.push(text)
  }
  for(const text of texts){
    expect(utf8Encode(text)).toBe(Buffer.byteLength(text))
    for(let length=0;length<=40;length++){
      const actual=new Uint8Array(48).fill(0xAB),expected=Buffer.alloc(48,0xAB)
      expect(utf8Write(actual,text,3,length)).toBe(expected.write(text,3,length,'utf8'))
      expect([...actual]).toEqual([...expected])
    }
  }
})
