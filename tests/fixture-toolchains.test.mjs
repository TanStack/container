import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,existsSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fixtureAssembler,resolveWasm3Source,resolveEmscripten} from '../scripts/fixture-toolchains.mjs'

test('toolchain paths use documented defaults or explicit overrides, never stale temp locations',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'fixture-toolchains-')))
  const source=join(root,'.toolchains/wasm3'),compiler=join(root,'.toolchains/emsdk/upstream/emscripten/emcc')
  mkdirSync(source,{recursive:true});mkdirSync(join(root,'.toolchains/emsdk/upstream/emscripten'),{recursive:true})
  writeFileSync(compiler,'#!/bin/sh\nexit 0\n');chmodSync(compiler,0o755)
  assert.equal(resolveWasm3Source({projectRoot:root,environment:{}}),source)
  assert.equal(resolveEmscripten({projectRoot:root,environment:{}}),compiler)
  assert.equal(resolveWasm3Source({environment:{WASM3_SOURCE_ROOT:source}}),source)
  assert.equal(resolveEmscripten({environment:{EMCC:compiler}}),compiler)
  assert.equal(resolveWasm3Source({source,environment:{WASM3_SOURCE_ROOT:'/missing'}}),source)
  assert.equal(resolveEmscripten({compiler,environment:{EMCC:'/missing'}}),compiler)
  assert.throws(()=>resolveWasm3Source({projectRoot:root,environment:{WASM3_SOURCE_ROOT:'/missing'}}),/WASM3_SOURCE_ROOT is missing/)
  assert.throws(()=>resolveEmscripten({projectRoot:root,environment:{EMCC:''}}),/nonempty path/)
  chmodSync(compiler,0o644)
  assert.throws(()=>resolveEmscripten({compiler}),/not executable/)
})

test('fixture assemblers require supported names and exact pinned bytes',()=>{
  const source=mkdtempSync(join(tmpdir(),'fixture-assembler-bad-'))
  mkdirSync(join(source,'test/wasi/wabt'),{recursive:true})
  writeFileSync(join(source,'test/wasi/wabt/wat2wasm.wasm'),'different binary')
  assert.throws(()=>fixtureAssembler('wat2wasm',{source}),/Unexpected pinned wat2wasm SHA256/)
  assert.throws(()=>fixtureAssembler('../other',{source}),/Unsupported fixture assembler/)
  assert.throws(()=>fixtureAssembler('wast2json',{source}),/Pinned wast2json is missing/)
})

for(const tool of ['wat2wasm','wast2json'])test(tool+' runs from an independent working directory without a native probe build',{
  skip:!existsSync(resolve('.toolchains/wasm3/test/wasi/wabt',tool+'.wasm')),
},()=>{
  const {command,prefix}=fixtureAssembler(tool,{environment:{}})
  const directory=mkdtempSync(join(tmpdir(),'fixture-wasi-run-'))
  const input=tool==='wat2wasm'?'input.wat':'input.wast',output=tool==='wat2wasm'?'output.wasm':'output.json'
  writeFileSync(join(directory,input),'(module (func (export "answer") (result i32) i32.const 42))')
  const result=spawnSync(command,[...prefix,input,'-o',output],{cwd:directory,encoding:'utf8',timeout:30000})
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout)
  const wasm=tool==='wat2wasm'?output:JSON.parse(readFileSync(join(directory,output))).commands[0].filename
  const instance=new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(directory,wasm))))
  assert.equal(instance.exports.answer(),42)
})
