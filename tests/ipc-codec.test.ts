import {test,expect,vi} from 'vitest'
import {serialize,deserialize} from 'node:v8'
// @ts-expect-error Guest JavaScript is exercised directly here.
import {encodeIPC,decodeIPC} from '../src/sandbox/guest-ipc-codec.js'
const copy=(value:any)=>decodeIPC(encodeIPC(value,'advanced'),'advanced')
const workerCopy=(value:any)=>decodeIPC(encodeIPC(value,'advanced',{}),'advanced',{})
test('WASM module resources keep large valid modules outside compact graph envelopes',()=>{
  // An ordinary custom section with 128 KiB of metadata, no executable code.
  const bytes=new Uint8Array(8+1+3+1+128*1024)
  bytes.set([0,97,115,109,1,0,0,0,0,0x81,0x80,0x08,0])
  const module=new WebAssembly.Module(bytes)
  const adopted=structuredClone(module)
  const encodeWasmModuleResource=vi.fn((value:unknown)=>value===module?17:undefined)
  const encodeWasmModule=vi.fn((_value:unknown)=>undefined)
  const decodeWasmModuleResource=vi.fn((id:number)=>{expect(id).toBe(17);return adopted})
  const text=encodeIPC([module,module],'advanced',{encodeWasmModuleResource,encodeWasmModule})
  expect(text.length).toBeLessThan(200)
  expect(JSON.parse(text).nodes.filter((node:any[])=>node[0]==='wasm-module-resource')).toEqual([['wasm-module-resource',17]])
  expect(JSON.parse(text).nodes.some((node:any[])=>node[0]==='buffer')).toBe(false)
  expect(encodeWasmModuleResource.mock.calls.filter(([value])=>value===module)).toHaveLength(1)
  expect(encodeWasmModule.mock.calls.filter(([value])=>value===module)).toHaveLength(0)
  const result=decodeIPC(text,'advanced',{decodeWasmModuleResource})
  expect(result[0]).toBe(adopted);expect(result[1]).toBe(result[0])
  expect(decodeWasmModuleResource).toHaveBeenCalledTimes(1)
  expect(new WebAssembly.Instance(result[0]).exports).toEqual({})
})
test('WASM module resource hooks validate identifiers and decoded modules',()=>{
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0]).buffer,module=new WebAssembly.Module(bytes)
  const decodeWasmModuleResource=vi.fn(()=>module)
  for(const id of [0,-1,1.5,0x100000000,'1',null,NaN,Infinity]){
    expect(()=>encodeIPC(module,'advanced',{encodeWasmModuleResource:()=>id})).toThrow('serialized')
    expect(()=>decodeIPC(JSON.stringify({root:['ref',0],nodes:[['wasm-module-resource',id]]}),'advanced',{decodeWasmModuleResource})).toThrow('serialized')
  }
  expect(decodeWasmModuleResource).not.toHaveBeenCalled()
  const text=encodeIPC(module,'advanced',{encodeWasmModuleResource:()=>0xffffffff})
  expect(()=>decodeIPC(text,'advanced')).toThrow('serialized')
  for(const value of [undefined,null,{},bytes])expect(()=>decodeIPC(text,'advanced',{decodeWasmModuleResource:()=>value})).toThrow('serialized')
  expect(decodeIPC(text,'advanced',{decodeWasmModuleResource})).toBe(module)
  expect(decodeWasmModuleResource).toHaveBeenCalledWith(0xffffffff)
})
test('undefined WASM module resource hooks retain the legacy byte codec',()=>{
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0]).buffer,module=new WebAssembly.Module(bytes)
  const text=encodeIPC(module,'advanced',{encodeWasmModuleResource:()=>undefined,encodeWasmModule:(value:unknown)=>value===module?bytes:undefined})
  const result=decodeIPC(text,'advanced',{decodeWasmModule:(value:ArrayBuffer)=>new WebAssembly.Module(value)})
  expect(result).toBeInstanceOf(WebAssembly.Module)
  expect(JSON.parse(text).nodes[0][0]).toBe('wasm-module')
})
test('WASM module hooks preserve repeated references and nested maps',()=>{
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0]).buffer
  const module=new WebAssembly.Module(bytes)
  const encodeWasmModule=vi.fn((value:unknown)=>value===module?bytes:undefined)
  const decodeWasmModule=vi.fn((value:ArrayBuffer)=>new WebAssembly.Module(value))
  const result=decodeIPC(encodeIPC({module,again:module,map:new Map([[module,{module}]])},'advanced',{encodeWasmModule}),'advanced',{decodeWasmModule})
  expect(result.module).toBeInstanceOf(WebAssembly.Module)
  expect(result.module).not.toBe(module);expect(result.again).toBe(result.module)
  expect(result.map.get(result.module).module).toBe(result.module)
  expect(new WebAssembly.Instance(result.module).exports).toEqual({})
  expect(decodeWasmModule).toHaveBeenCalledTimes(1)
})
test('WASM modules require correctly shaped encode and decode hooks',()=>{
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0]).buffer,module=new WebAssembly.Module(bytes)
  expect(()=>workerCopy(module)).toThrow('serialized')
  for(const value of [null,1,{},new Uint8Array(bytes)])expect(()=>encodeIPC(module,'advanced',{encodeWasmModule:()=>value})).toThrow('serialized')
  const text=encodeIPC(module,'advanced',{encodeWasmModule:(value:unknown)=>value===module?bytes:undefined})
  expect(()=>decodeIPC(text,'advanced')).toThrow('serialized')
  for(const value of [undefined,null,{},bytes])expect(()=>decodeIPC(text,'advanced',{decodeWasmModule:()=>value})).toThrow('serialized')
})
test('shared WASM memory hooks preserve repeated references and live growth',()=>{
  const memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true})
  const adopted=structuredClone(memory)
  const encodeWasmMemory=vi.fn((value:unknown)=>value===memory?8:undefined)
  const decodeWasmMemory=vi.fn((id:number)=>{expect(id).toBe(8);return adopted})
  const result=decodeIPC(encodeIPC({memory,again:memory},'advanced',{encodeWasmMemory}),'advanced',{decodeWasmMemory})
  expect(result.memory).toBe(adopted);expect(result.again).toBe(adopted)
  expect(decodeWasmMemory).toHaveBeenCalledTimes(1)
  result.memory.grow(1);expect(memory.buffer.byteLength).toBe(131072)
  new Uint8Array(result.memory.buffer)[65536]=42
  expect(new Uint8Array(memory.buffer)[65536]).toBe(42)
})
test('WASM memory messages require hooks and valid scoped identifiers',()=>{
  const memory=new WebAssembly.Memory({initial:0,maximum:1,shared:true})
  expect(()=>workerCopy(memory)).toThrow('serialized')
  const text=encodeIPC(memory,'advanced',{encodeWasmMemory:()=>1})
  expect(()=>decodeIPC(text,'advanced')).toThrow('serialized')
  const decodeWasmMemory=vi.fn()
  for(const id of [0,-1,1.5,0x100000000,'1',null]){
    expect(()=>encodeIPC(memory,'advanced',{encodeWasmMemory:()=>id})).toThrow('serialized')
    expect(()=>decodeIPC(JSON.stringify({root:['ref',0],nodes:[['wasm-memory',id]]}),'advanced',{decodeWasmMemory})).toThrow('serialized')
  }
  expect(decodeWasmMemory).not.toHaveBeenCalled()
})
test('IPC advanced values match Node serialization for common messages',()=>{
  const value={bytes:new Uint8Array([0,255]),big:123n,date:new Date(123),regexp:/hello/gi,map:new Map([[1,'a']]),set:new Set([2]),numbers:[NaN,Infinity,-Infinity,-0],missing:undefined}
  expect(copy(value)).toEqual(deserialize(serialize(value)))
})
test('IPC preserves cycles, aliases and array holes without prototype mutation',()=>{
  const child={answer:42},value:any={a:child,b:child,array:new Array(3)};value.self=value
  Object.defineProperty(value,'__proto__',{value:{unsafe:true},enumerable:true})
  const result=copy(value)
  expect(result.self).toBe(result);expect(result.a).toBe(result.b)
  expect(0 in result.array).toBe(false);expect(result.array.length).toBe(3)
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  expect(Object.hasOwn(result,'__proto__')).toBe(true)
})
test('IPC rejects functions and weak collections, JSON follows JSON semantics',()=>{
  for(const value of [()=>{},Symbol('x'),new WeakMap()])expect(()=>copy(value)).toThrow()
  expect(decodeIPC(encodeIPC({a:undefined,n:NaN}))).toEqual({n:null})
  expect(()=>encodeIPC({n:1n})).toThrow()
})
test('IPC preserves standard Error subclasses and causes like Node serialization',()=>{
  for(const value of [new Error('base',{cause:7}),new EvalError('eval'),new RangeError('large'),new ReferenceError('missing'),new SyntaxError('bad'),new TypeError('wrong',{cause:{answer:42}}),new URIError('uri'),new AggregateError([new Error('nested')],'aggregate',{cause:9})]){
    const expected=deserialize(serialize(value)),actual=copy(value)
    expect(actual.constructor).toBe(expected.constructor)
    expect({name:actual.name,message:actual.message,cause:actual.cause}).toEqual({name:expected.name,message:expected.message,cause:expected.cause})
  }
})
test('IPC preserves ArrayBuffer aliases, typed view ranges and cyclic collections like Node serialization',()=>{
  const buffer=new ArrayBuffer(16),bytes=new Uint8Array(buffer);bytes.set([0,1,2,3,4,5,6,7])
  const value:any={buffer,bytes:new Uint8Array(buffer,1,5),words:new Uint16Array(buffer,2,2),view:new DataView(buffer,4,4)}
  value.self=value;value.map=new Map([['self',value],['bytes',value.bytes]]);value.set=new Set([value,value.words])
  const expected=deserialize(serialize(value)),actual=copy(value)
  expect([...actual.bytes]).toEqual([...expected.bytes]);expect([...actual.words]).toEqual([...expected.words])
  expect(actual.view.byteLength).toBe(expected.view.byteLength)
  expect([actual.bytes.buffer===actual.buffer,actual.words.buffer===actual.buffer,actual.view.buffer===actual.buffer]).toEqual([expected.bytes.buffer===expected.buffer,expected.words.buffer===expected.buffer,expected.view.buffer===expected.buffer])
  expect(actual.self).toBe(actual);expect(actual.map.get('self')).toBe(actual);expect(actual.map.get('bytes')).toBe(actual.bytes)
  expect(actual.set.has(actual)).toBe(true);expect(actual.set.has(actual.words)).toBe(true)
})
test('worker messages preserve shared view buffers like native structured clone',()=>{
  const buffer=new ArrayBuffer(12),value:any={buffer,bytes:new Uint8Array(buffer,1,5),words:new Uint16Array(buffer,2,2),view:new DataView(buffer,4,4)};value.self=value
  const expected=structuredClone(value),actual=workerCopy(value)
  expect([...actual.bytes]).toEqual([...expected.bytes]);expect([...actual.words]).toEqual([...expected.words])
  expect(actual.bytes.buffer).toBe(actual.buffer);expect(actual.words.buffer).toBe(actual.buffer);expect(actual.view.buffer).toBe(actual.buffer);expect(actual.self).toBe(actual)
})
test('shared buffer hooks preserve graph identity and typed-view aliases without copying bytes',()=>{
  const shared=new SharedArrayBuffer(16),value:any={shared,again:shared,bytes:new Uint8Array(shared,1,5),words:new Int32Array(shared,4,2),view:new DataView(shared,3,4)}
  value.self=value
  const encodeSharedBuffer=vi.fn((buffer:SharedArrayBuffer)=>{expect(buffer).toBe(shared);return 7})
  const adopted=structuredClone(shared),decodeSharedBuffer=vi.fn((id:number)=>{expect(id).toBe(7);return adopted})
  const text=encodeIPC(value,'advanced',{encodeSharedBuffer})
  const result=decodeIPC(text,'advanced',{decodeSharedBuffer})
  expect(encodeSharedBuffer).toHaveBeenCalledTimes(1);expect(decodeSharedBuffer).toHaveBeenCalledTimes(1)
  expect(result.shared).toBe(adopted);expect(result.again).toBe(adopted);expect(result.self).toBe(result)
  for(const key of ['bytes','words','view'])expect(result[key].buffer).toBe(adopted)
  expect([result.bytes.byteOffset,result.words.byteOffset,result.view.byteOffset]).toEqual([1,4,3])
  expect([result.bytes.byteLength,result.words.byteLength,result.view.byteLength]).toEqual([5,8,4])
  result.bytes[0]=42;expect(new Uint8Array(shared)[1]).toBe(42)
  expect(JSON.parse(text).nodes.filter((node:any[])=>node[0]==='shared-buffer')).toEqual([['shared-buffer',7]])
})
test('shared buffers and their views require explicit hooks',()=>{
  const shared=new SharedArrayBuffer(8)
  for(const value of [shared,new Uint8Array(shared),new DataView(shared)]){
    expect(()=>copy(value)).toThrow('serialized')
    expect(()=>workerCopy(value)).toThrow('serialized')
  }
  const text=encodeIPC(shared,'advanced',{encodeSharedBuffer:()=>1})
  expect(()=>decodeIPC(text,'advanced')).toThrow('serialized')
  expect(()=>decodeIPC(text,'advanced',{decodeSharedBuffer:()=>new ArrayBuffer(8)})).toThrow('serialized')
})
test('shared identifiers are bounded integers on both sides before adoption',()=>{
  const shared=new SharedArrayBuffer(1),decodeSharedBuffer=vi.fn(()=>shared)
  for(const id of [0,-1,1.5,0x100000000,'1',null]){
    expect(()=>encodeIPC(shared,'advanced',{encodeSharedBuffer:()=>id})).toThrow('serialized')
    expect(()=>decodeIPC(JSON.stringify({root:['ref',0],nodes:[['shared-buffer',id]]}),'advanced',{decodeSharedBuffer})).toThrow('serialized')
  }
  expect(decodeSharedBuffer).not.toHaveBeenCalled()
})
test('shared hooks leave ordinary buffers and port extensions unchanged',()=>{
  const port={},shared=new SharedArrayBuffer(4),ordinary=new ArrayBuffer(4)
  const encoded=encodeIPC({port,shared,ordinary},'advanced',{
    encodePort:(value:unknown)=>value===port?12:undefined,
    encodeSharedBuffer:()=>4,
  })
  const decodedPort={adopted:true},result=decodeIPC(encoded,'advanced',{
    decodePort:(id:number)=>{expect(id).toBe(12);return decodedPort},
    decodeSharedBuffer:()=>shared,
  })
  expect(result.port).toBe(decodedPort);expect(result.shared).toBe(shared)
  expect(result.ordinary).toBeInstanceOf(ArrayBuffer);expect(result.ordinary).not.toBe(ordinary)
})
