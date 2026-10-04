import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'

const require=createRequire(import.meta.url)
const runtimeRoot=dirname(require.resolve('@napi-rs/wasm-runtime'))
assert.equal(JSON.parse(readFileSync(join(runtimeRoot,'package.json'))).version,'1.2.4')
const {WASI}=require('@napi-rs/wasm-runtime')
const {memfs}=await import(pathToFileURL(join(runtimeRoot,'dist/fs.js')).href)

// A real WASM reactor exporting one memory. The calls use the installed
// compiler's WASI implementation, not our guest WASI or a mocked syscall.
const reactor=new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0,5,3,1,0,1,
  7,10,1,6,109,101,109,111,114,121,2,0,
]))
function openRoot(fs){
  const wasi=new WASI({version:'preview1',fs,preopens:{'/':'/'}})
  const instance=new WebAssembly.Instance(reactor)
  wasi.initialize(instance)
  const view=new DataView(instance.exports.memory.buffer)
  return {
    rootStat(){
      const errno=wasi.wasiImport.fd_filestat_get(3,64)
      return {errno,type:errno===0?view.getUint8(80):null}
    },
    pathStat(path){
      const name=new TextEncoder().encode(path)
      new Uint8Array(view.buffer).set(name,256)
      const errno=wasi.wasiImport.path_filestat_get(3,1,256,name.length,64)
      return {errno,type:errno===0?view.getUint8(80):null,
        size:errno===0?view.getBigUint64(96,true):null}
    },
    close(){return wasi.wasiImport.fd_close(3)},
  }
}

test('installed compiler WASI observes ordinary edits on the same filesystem',()=>{
  const {fs}=memfs(),control=openRoot(fs)
  try{
    assert.deepEqual(control.rootStat(),{errno:0,type:3})
    fs.mkdirSync('/app')
    fs.writeFileSync('/app/input.js','one')
    assert.deepEqual(control.pathStat('app/input.js'),{errno:0,type:4,size:3n})
    fs.writeFileSync('/app/input.js','edited')
    assert.deepEqual(control.pathStat('app/input.js'),{errno:0,type:4,size:6n})
    fs.renameSync('/app/input.js','/app/renamed.js')
    assert.equal(control.pathStat('app/input.js').errno,44)
    assert.deepEqual(control.pathStat('app/renamed.js'),{errno:0,type:4,size:6n})
  }finally{assert.equal(control.close(),0)}
})

test('negative control: resetting the volume invalidates the compiler preopen',()=>{
  const {fs,vol}=memfs(),control=openRoot(fs)
  assert.deepEqual(control.rootStat(),{errno:0,type:3})
  vol.reset()
  // This is the dependency failure, not a passing workspace-reset contract.
  assert.deepEqual(control.rootStat(),{errno:8,type:null})
  fs.mkdirSync('/app')
  fs.writeFileSync('/app/replacement.js','new workspace')
  assert.equal(control.pathStat('app/replacement.js').errno,0)
  assert.deepEqual(control.rootStat(),{errno:8,type:null})
  // The stale descriptor is already invalid. A second close must report that.
  assert.equal(control.close(),8)
  const replacement=openRoot(fs)
  try{
    assert.deepEqual(replacement.rootStat(),{errno:0,type:3})
    assert.deepEqual(replacement.pathStat('app/replacement.js'),{errno:0,type:4,size:13n})
  }finally{assert.equal(replacement.close(),0)}
})

test('clearing directory contents preserves the open root, including across mounts',()=>{
  const {fs}=memfs(),control=openRoot(fs)
  try{
    for(let mount=0;mount<3;mount++){
      for(const name of fs.readdirSync('/'))fs.rmSync(`/${name}`,{recursive:true})
      fs.mkdirSync('/app')
      fs.writeFileSync(`/app/mount-${mount}.js`,'next')
      assert.deepEqual(control.rootStat(),{errno:0,type:3})
      assert.deepEqual(control.pathStat(`app/mount-${mount}.js`),{errno:0,type:4,size:4n})
      if(mount)assert.equal(control.pathStat(`app/mount-${mount-1}.js`).errno,44)
    }
  }finally{assert.equal(control.close(),0)}
})
