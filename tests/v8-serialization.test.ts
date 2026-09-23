import {test,expect} from 'vitest'
import * as native from 'node:v8'
// @ts-expect-error Guest implementation is compared with Node's wire format.
import {serialize,deserialize} from '../src/sandbox/guest-v8-serialization.js'
test('V8 scalar and RPC messages cross-decode with Node',()=>{
  for(const value of [undefined,null,true,false,0,-0,NaN,Infinity,-1,1.5,'abc','你好','\ud800',[],[1,undefined],{m:'fetch',a:['/@vite/env','ssr'],i:'request',t:'q'}]){
    expect(deserialize(native.serialize(value))).toEqual(value)
    expect(native.deserialize(serialize(value))).toEqual(value)
  }
})
test('V8 graph references and holes cross-decode with Node',()=>{
  const value:any={array:new Array(3)};value.self=value;value.alias=value.array
  for(const copy of [deserialize(native.serialize(value)),native.deserialize(serialize(value))]){
    expect(copy.self).toBe(copy);expect(copy.alias).toBe(copy.array);expect(0 in copy.array).toBe(false)
  }
})
test('V8 decoder rejects every truncated prefix, invalid references and unknown tags',()=>{
  const valid=native.serialize({m:'fetch',a:['/@vite/env','ssr'],nested:{answer:42}})
  for(let length=0;length<valid.length;length++)expect(()=>deserialize(valid.subarray(0,length)),String(length)).toThrow()
  for(const hex of ['ff0f5e00','ff0f3f','ff0f61ffffffff0f','ff0f6f7b01','ff0f6301ff','ff0fffffffffff7f'])expect(()=>deserialize(Buffer.from(hex,'hex')),hex).toThrow()
})
test('V8 decoder retains own __proto__ keys without changing prototypes',()=>{
  const value=JSON.parse('{"__proto__":{"polluted":true}}')
  const decoded=deserialize(native.serialize(value))
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
  expect(Object.hasOwn(decoded,'__proto__')).toBe(true)
  expect(decoded.polluted).toBeUndefined()
})
