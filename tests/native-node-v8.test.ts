import {expect,test} from 'vitest'
import * as node from 'node:v8'
import {serialize,deserialize} from '../src/vite-browser/node-v8'

test('array buffers retain their bytes and shared identity with Node',()=>{
  for(const buffer of [new ArrayBuffer(0),new Uint8Array([1,2,255]).buffer]){
    for(const output of [node.deserialize(serialize([buffer,buffer])),deserialize(node.serialize([buffer,buffer]))] as ArrayBuffer[][]){
      expect(output[0]).toBe(output[1])
      expect(output[0]).toBeInstanceOf(ArrayBuffer)
      expect(new Uint8Array(output[0]!)).toEqual(new Uint8Array(buffer))
    }
  }
  expect(()=>deserialize(new Uint8Array([255,15,66,3,1]))).toThrow('Truncated')
})

test('numeric views preserve type, bytes, sliced ranges and identity with Node',()=>{
  const types=[Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,
    Int32Array,Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array]
  const values:ArrayBufferView[]=types.map(Type=>{
    const buffer=new ArrayBuffer(Type.BYTES_PER_ELEMENT*4)
    const bytes=new Uint8Array(buffer);bytes.fill(1)
    return new Type(buffer,Type.BYTES_PER_ELEMENT,2)
  })
  values.push(new DataView(new Uint8Array([9,1,2,3,9]).buffer,1,3))
  for(const value of values){
    for(const output of [node.deserialize(serialize([value,value])),deserialize(node.serialize([value,value]))] as ArrayBufferView[][]){
      expect(output[0]).toBe(output[1])
      expect(output[0]!.constructor).toBe(value.constructor)
      expect(new Uint8Array(output[0]!.buffer,output[0]!.byteOffset,output[0]!.byteLength))
        .toEqual(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))
    }
  }
  expect(()=>deserialize(new Uint8Array([255,15,92,3,1,0]))).toThrow('typed array length')
})

test('binary RPC values interoperate with Node in both directions',()=>{
  for(const value of [undefined,null,true,false,0,-1,2147483647,1.5,-0,NaN,Infinity,
    0n,1n,-1n,2n**65n,-(2n**120n),
    'hello','héllo','你好','😀','\ud800','\udfff','\ufeffhello',{nested:'\ud800',bom:'\ufeff'},
    {m:'fetch',a:['/@vite/env','ssr'],i:'abc',t:'q'},
    Buffer.from([1,2]),new Uint8Array([3,4])]){
    expect(node.deserialize(serialize(value))).toEqual(value)
    expect(deserialize(node.serialize(value))).toEqual(value)
  }
})
test('cycles, shared references and prototype-shaped keys survive',()=>{
  const shared={answer:5};const value:any={a:shared,b:shared};value.self=value
  for(const output of [node.deserialize(serialize(value)),deserialize(node.serialize(value))] as any[]){
    expect(output.a).toBe(output.b);expect(output.self).toBe(output)
  }
  const output=deserialize(node.serialize(JSON.parse('{"__proto__":{"answer":5}}'))) as any
  expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
  expect(Object.hasOwn(output,'__proto__')).toBe(true)
})
test('unsupported values and malformed inputs fail clearly',()=>{
  expect(()=>serialize(new WeakMap())).toThrow('Unsupported')
  expect(()=>serialize(()=>{})).toThrow('Unsupported')
  expect(()=>deserialize(new Uint8Array([255,15,83,20]))).toThrow('Truncated')
  expect(()=>deserialize(new Uint8Array([255,15,90,16,1]))).toThrow('Truncated')
})

test('regular expressions interoperate with Node and preserve shared identity',()=>{
  for(const flags of ['', 'g','i','m','y','u','s','d','v','dgimsuy']){
    const pattern=new RegExp('你好[abc]+',flags)
    pattern.lastIndex=5
    for(const output of [node.deserialize(serialize([pattern,pattern])),deserialize(node.serialize([pattern,pattern]))] as RegExp[][]){
      expect(output[0]).toBe(output[1])
      expect(output[0]!.source).toBe(pattern.source)
      expect(output[0]!.flags).toBe(pattern.flags)
      expect(output[0]!.lastIndex).toBe(0)
    }
  }
  expect(()=>deserialize(new Uint8Array([255,15,82,34,1,97]))).toThrow('Truncated')
  expect(()=>deserialize(new Uint8Array([255,15,82,34,1,97,64]))).toThrow('Invalid V8 RegExp')
})

test('dates, maps and sets interoperate with Node and retain reference graphs',()=>{
  for(const value of [new Date(42),new Date(NaN),new Map(),new Set(),new Map([[{key:1},new Set([2,3])]])]){
    expect(node.deserialize(serialize(value))).toEqual(value)
    expect(deserialize(node.serialize(value))).toEqual(value)
  }
  const date=new Date(123)
  const map=new Map<unknown,unknown>(),set=new Set<unknown>()
  map.set(map,set);set.add(map);set.add(date)
  const value={map,set,date,again:date}
  for(const result of [node.deserialize(serialize(value)),deserialize(node.serialize(value))] as typeof value[]){
    expect(result.map.get(result.map)).toBe(result.set)
    expect(result.set.has(result.map)).toBe(true)
    expect(result.set.has(result.date)).toBe(true)
    expect(result.date).toBe(result.again)
  }
  expect(()=>deserialize(new Uint8Array([255,15,68,1]))).toThrow('Truncated')
  expect(()=>deserialize(new Uint8Array([255,15,59,58,1]))).toThrow('map count')
  expect(()=>deserialize(new Uint8Array([255,15,39,44,1]))).toThrow('set count')
})
