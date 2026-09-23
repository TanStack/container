import assert from 'node:assert/strict'
import {WASI} from 'node:wasi'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const directory=mkdtempSync(join(tmpdir(),'wasi-open-control-'))
writeFileSync(join(directory,'regular.txt'),'hello')
const wasi=new WASI({version:'preview1',preopens:{'/fixture':directory}})
// Valid reactor exporting one page of memory, no imported functions.
const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0])
const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes),wasi.getImportObject())
wasi.initialize(instance)
const memory=new Uint8Array(instance.exports.memory.buffer),view=new DataView(memory.buffer)
memory.set(new TextEncoder().encode('regular.txt'),64)
const rights=bits=>bits.reduce((a,b)=>a|(1n<<BigInt(b)),0n)
const file=rights([1,2,5,6,21,27]),dir=rights([9,10,13,14,15,18,19,21,25,26])
const cases=[]
for(const [label,base,inheriting] of [['read',2n,0n],['file',file,0n],['mixed-base',file|dir,0n],['mixed-both',file|dir,file|dir],['file-inherit',file,file|dir]])for(const flags of [0,4]){
  const errno=wasi.wasiImport.path_open(3,1,64,11,0,base,inheriting,flags,128)
  assert.equal(errno,0,`${label} flags=${flags}`)
  const fd=view.getUint32(128,true)
  try{
    assert.equal(wasi.wasiImport.fd_fdstat_get(fd,160),0)
    const actualFlags=view.getUint16(162,true),actualBase=view.getBigUint64(168,true),actualInheriting=view.getBigUint64(176,true)
    assert.equal(view.getUint8(160),4)
    assert.equal(actualBase,base&file)
    assert.equal(actualInheriting,0n)
    // Other native fd flags can depend on the host platform.
    assert.equal(actualFlags&4,flags)
    cases.push({label,flags,errno,actualFlags,requestedBase:String(base),requestedInheriting:String(inheriting),base:String(actualBase),inheriting:String(actualInheriting)})
  }finally{assert.equal(wasi.wasiImport.fd_close(fd),0)}
}
console.log(JSON.stringify({node:process.version,platform:process.platform,directory,cases},null,2))
