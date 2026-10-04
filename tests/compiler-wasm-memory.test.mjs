import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {compilerWasmMemory,sizeCompilerMemoryBinding} from '../scripts/compiler-wasm-memory.mjs'

const u32=value=>{const bytes=[];do{const part=value%128;value=Math.floor(value/128);bytes.push(part|(value?128:0))}while(value);return bytes}
const name=value=>{const bytes=[...Buffer.from(value)];return [...u32(bytes.length),...bytes]}
const section=(id,bytes)=>[id,...u32(bytes.length),...bytes]
const memoryImport=(minimum=2,maximum=4,flags=3,module='env',field='memory')=>
  [...name(module),...name(field),2,...u32(flags),...u32(minimum),...(flags&1?u32(maximum):[])]
function wasm({imports=[memoryImport()],before=[],after=[]}={}){
  return Uint8Array.from([0,97,115,109,1,0,0,0,...before,
    ...section(2,[imports.length,...imports.flat()]),...after])
}
const binding='// original\nconst memory = new WebAssembly.Memory({ initial: 3, maximum: 4, shared: true });\n'

test('binding uses the actual module minimum without changing WASM or other source tokens',()=>{
  const bytes=wasm(),original=bytes.slice(),result=sizeCompilerMemoryBinding(binding,bytes)
  assert.equal(result.contents,binding.replace('initial: 3','initial: 2'))
  assert.deepEqual(bytes,original)
  assert.deepEqual(result.memory,{module:'env',name:'memory',initialPages:2,maximumPages:4,shared:true,
    wasmSHA256:createHash('sha256').update(original).digest('hex'),upstreamInitialPages:3})
  assert.deepEqual(sizeCompilerMemoryBinding(result.contents,bytes),{contents:result.contents,
    memory:{...result.memory,upstreamInitialPages:2}})
})

test('real WASM links, initializes data and grows shared memory up to the original maximum',()=>{
  const body=[0,0x20,0,0x40,0,0x0b]
  const bytes=wasm({before:section(1,[1,0x60,1,0x7f,1,0x7f]),after:[
    ...section(3,[1,0]),
    ...section(7,[2,...name('memory'),2,0,...name('grow'),0,0]),
    ...section(10,[1,...u32(body.length),...body]),
    // An active data segment near the end of page two.
    ...section(11,[1,0,0x41,0xfc,0xff,0x07,0x0b,4,1,2,3,4]),
  ]})
  const result=sizeCompilerMemoryBinding(binding,bytes)
  const memory=Function(result.contents+'return memory')()
  const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{memory}})
  assert.equal(instance.exports.memory,memory)
  assert(memory.buffer instanceof SharedArrayBuffer)
  assert.equal(memory.buffer.byteLength,2*65536)
  assert.deepEqual([...new Uint8Array(memory.buffer,131068,4)],[1,2,3,4])
  const previous=memory.buffer
  assert.equal(memory.grow(1),2)
  assert.equal(instance.exports.grow(1),3)
  assert.equal(memory.buffer.byteLength,4*65536)
  assert.equal(previous.byteLength,2*65536)
  assert.deepEqual([...new Uint8Array(previous,131068,4)],[1,2,3,4])
  assert.throws(()=>memory.grow(1),RangeError)
  assert.equal(instance.exports.grow(1),-1)
  assert.throws(()=>new WebAssembly.Instance(new WebAssembly.Module(bytes),{
    env:{memory:new WebAssembly.Memory({initial:1,maximum:4,shared:true})},
  }),WebAssembly.LinkError)
})

test('reads memory after ordinary function, table and global imports and custom sections',()=>{
  const bytes=wasm({before:[...section(0,[...name('fixture'),9,8,7]),...section(1,[1,0x60,0,0])],
    imports:[
      [...name('host'),...name('fn'),0,0],
      [...name('host'),...name('table'),1,0x70,1,1,2],
      [...name('host'),...name('global'),3,0x7f,0],memoryImport(1001,65536),
    ]})
  assert.equal(compilerWasmMemory(bytes).initialPages,1001)
  assert.equal(compilerWasmMemory(bytes).maximumPages,65536)
})

test('rejects invalid bytes, unsupported memory shape and different import identities',()=>{
  for(const bytes of [new Uint8Array(),wasm().slice(0,-1),wasm({imports:[]}),
    wasm({imports:[memoryImport(),memoryImport()]}),wasm({imports:[memoryImport(2,4,1)]}),
    wasm({imports:[memoryImport(2,4,3,'other')]}),wasm({imports:[memoryImport(2,4,3,'env','other')]}),
    wasm({imports:[memoryImport(2,4,3)],after:section(5,[1,0,1])}),
    wasm({imports:[memoryImport(5,4)]}),wasm({imports:[memoryImport(2,65537)]})])
    assert.throws(()=>compilerWasmMemory(bytes))
  assert.throws(()=>compilerWasmMemory(new ArrayBuffer(8)),/WASM bytes/)
})

test('rejects binding drift rather than changing sharing, maxima or unrelated constructors',()=>{
  const bytes=wasm()
  for(const source of [binding.replace('initial: 3','initial: 1'),
    binding.replace('maximum: 4','maximum: 5'),binding.replace('shared: true','shared: false'),
    binding.replace('initial: 3','initial: wanted'),binding.replace('initial: 3','initial: 3, initial: 3'),
    binding.replace('initial: 3','initial: 3, extra: 1'),binding.replace('initial: 3','...limits, initial: 3'),
    binding.replace('{ initial: 3, maximum: 4, shared: true }','limits'),binding+binding,
    '// new WebAssembly.Memory({ initial: 3, maximum: 4, shared: true })',
    binding.replace('new WebAssembly.Memory','new Other.Memory'),binding+'\nconst = ;'])
    assert.throws(()=>sizeCompilerMemoryBinding(source,bytes))
})

test('pinned browser Rolldown versions declare the same shared memory limits',()=>{
  for(const [root,version] of [['node_modules/@rolldown/browser','1.2.11'],
    ['tests/fixtures/native-runtime-832/node_modules/@rolldown/browser','1.2.12']]){
    const manifest=JSON.parse(readFileSync(root+'/package.json','utf8'))
    assert.equal(manifest.name,'@rolldown/browser')
    assert.equal(manifest.version,version)
    const bytes=readFileSync(root+'/dist/rolldown-binding.wasm32-wasi.wasm')
    const source=readFileSync(root+'/dist/rolldown-binding.wasi-browser.js','utf8')
    const result=sizeCompilerMemoryBinding(source,bytes)
    assert.equal(result.memory.initialPages,1001)
    assert.equal(result.memory.maximumPages,65536)
    assert.equal(result.memory.shared,true)
    assert.equal(result.memory.upstreamInitialPages,16384)
    assert.equal(result.contents,source.replace('initial: 16384','initial: 1001'))
  }
})
