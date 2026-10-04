import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const backendURL=process.env.NATIVE_FILESYSTEM_BACKEND_URL??new URL('../src/native/filesystem-backend.mjs',import.meta.url).href
const {createNativeFilesystemBackend}=await import(backendURL)
const upstreamURL=process.env.NATIVE_FILESYSTEM_UPSTREAM_URL??'memfs'
const {memfs}=await import(upstreamURL)
const factory=process.env.NATIVE_FILESYSTEM_CURSOR_CONTROL==='upstream'?memfs:createNativeFilesystemBackend

// Both backends execute the same operations, including reads that reveal the fd cursor.
async function compare(operation,contents='abcdefghij'){
  const directory=nodeFs.mkdtempSync(join(tmpdir(),'native-fs-cursor-oracle-'))
  const file=join(directory,'file')
  const {fs}=factory()
  nodeFs.writeFileSync(file,contents);fs.writeFileSync('/file',contents)
  try{
    const expected=await operation(nodeFs,file)
    const actual=await operation(fs,'/file')
    assert.deepEqual(actual,expected)
  }finally{
    // The test owns exactly this file and empty directory, no recursive cleanup.
    nodeFs.unlinkSync(file);nodeFs.rmdirSync(directory)
  }
}
function next(fs,fd,length=3){
  const buffer=Buffer.alloc(length,46),bytes=fs.readSync(fd,buffer,0,length,null)
  return {bytes,text:buffer.toString()}
}
function withDescriptor(fs,path,flags,fn){
  const fd=fs.openSync(path,flags)
  try{return fn(fd)}finally{fs.closeSync(fd)}
}
function callback(fs,method,...args){
  return new Promise((resolve,reject)=>fs[method](...args,(error,count,buffer)=>
    error?reject(error):resolve({count,buffer})))
}

for(const method of ['readFile','writeFile','appendFile']){
  test(`whole-file ${method}Sync uses the existing descriptor position`,()=>compare((fs,path)=>
    withDescriptor(fs,path,'r+',fd=>{
      const before=next(fs,fd,2)
      const value=method==='readFile'?fs.readFileSync(fd,'utf8'):fs[method+'Sync'](fd,'XY')
      return {before,value,after:next(fs,fd),contents:fs.readFileSync(path,'utf8')}
    })))
  test(`whole-file ${method} callback uses the existing descriptor position`,()=>compare(async(fs,path)=>{
    const fd=fs.openSync(path,'r+')
    try{
      const before=next(fs,fd,2)
      const value=method==='readFile'?await callback(fs,method,fd,'utf8'):await callback(fs,method,fd,'XY')
      return {before,value,after:next(fs,fd),contents:fs.readFileSync(path,'utf8')}
    }finally{fs.closeSync(fd)}
  }))
}

for(const position of [0,4,20])test(`positioned scalar read at ${position} leaves the cursor unchanged`,()=>
  compare((fs,path)=>withDescriptor(fs,path,'r',fd=>{
    const before=next(fs,fd,2),buffer=Buffer.alloc(3,46)
    const bytes=fs.readSync(fd,buffer,0,3,position)
    return {before,bytes,text:buffer.toString(),after:next(fs,fd)}
  })))

for(const position of [0,4,20])test(`positioned scalar write at ${position} leaves the cursor unchanged`,()=>
  compare((fs,path)=>withDescriptor(fs,path,'r+',fd=>{
    const before=next(fs,fd,2),bytes=fs.writeSync(fd,Buffer.from('XYZ'),0,3,position)
    return {before,bytes,after:next(fs,fd),contents:[...fs.readFileSync(path)]}
  })))

for(const position of [null,0,5,8,20])test(`vector read at ${position} has Node offsets and cursor`,()=>
  compare((fs,path)=>withDescriptor(fs,path,'r',fd=>{
    next(fs,fd,2)
    const buffers=[Buffer.alloc(2,46),Buffer.alloc(0),Buffer.alloc(3,46)]
    const bytes=fs.readvSync(fd,buffers,position)
    return {bytes,text:buffers.map(b=>b.toString()),after:next(fs,fd)}
  })))

for(const position of [null,0,5,20])test(`vector write at ${position} has Node offsets and cursor`,()=>
  compare((fs,path)=>withDescriptor(fs,path,'r+',fd=>{
    next(fs,fd,2)
    const backing=new Uint8Array([46,88,89,46]),view=new DataView(backing.buffer,1,2)
    const bytes=fs.writevSync(fd,[view,new Uint8Array(0),Buffer.from('Z')],position)
    return {bytes,after:next(fs,fd),contents:[...fs.readFileSync(path)]}
  })))

test('implicit scalar operations share one cursor while independent descriptors do not',()=>
  compare((fs,path)=>withDescriptor(fs,path,'r+',fd=>withDescriptor(fs,path,'r',other=>{
    const before=next(fs,fd,2),bytes=fs.writeSync(fd,Buffer.from('XY'))
    return {before,bytes,after:next(fs,fd),other:next(fs,other)}
  }))))

for(const position of [null,0,4])test(`append scalar write at ${position} uses EOF with Node cursor rules`,
  {skip:position!==null&&process.platform!=='linux'?'Positioned append is kernel-specific, this comparison needs Linux Node':false},()=>
  compare((fs,path)=>withDescriptor(fs,path,'a+',fd=>{
    const initial=next(fs,fd,2),bytes=fs.writeSync(fd,Buffer.from('XY'),0,2,position)
    return {initial,bytes,after:next(fs,fd),contents:fs.readFileSync(path,'utf8')}
  })))

for(const position of [null,0])test(`append vector write at ${position} uses EOF with Node cursor rules`,
  {skip:position!==null&&process.platform!=='linux'?'Positioned append is kernel-specific, this comparison needs Linux Node':false},()=>
  compare((fs,path)=>withDescriptor(fs,path,'a+',fd=>{
    next(fs,fd,2)
    const bytes=fs.writevSync(fd,[Buffer.from('X'),Buffer.from('YZ')],position)
    return {bytes,after:next(fs,fd),contents:fs.readFileSync(path,'utf8')}
  })))

for(const vector of [false,true])test(`Linux-style positioned append ${vector?'vector':'scalar'} preserves the read cursor`,()=>{
  const {fs}=factory({'/file':'abcdefghij'})
  withDescriptor(fs,'/file','a+',fd=>{
    assert.deepEqual(next(fs,fd,2),{bytes:2,text:'ab'})
    const bytes=vector?fs.writevSync(fd,[Buffer.from('X'),Buffer.from('YZ')],0):
      fs.writeSync(fd,Buffer.from('XYZ'),0,3,0)
    assert.equal(bytes,3)
    assert.equal(fs.readFileSync('/file','utf8'),'abcdefghijXYZ')
    assert.deepEqual(next(fs,fd),{bytes:3,text:'cde'})
  })
})

test('zero-byte writes do not extend the file or move the append cursor',()=>
  compare((fs,path)=>withDescriptor(fs,path,'a+',fd=>{
    next(fs,fd,2)
    const bytes=fs.writeSync(fd,Buffer.alloc(0),0,0,30)
    const vector=fs.writevSync(fd,[Buffer.alloc(0)],30)
    return {bytes,vector,after:next(fs,fd),size:fs.statSync(path).size}
  })))

test('callback scalar and vector positioned I/O shares the same descriptor rules',()=>compare(async(fs,path)=>{
  const fd=fs.openSync(path,'r+')
  try{
    const scalar=await callback(fs,'read',fd,Buffer.alloc(2),0,2,4)
    const afterRead=next(fs,fd,2)
    const vector=await callback(fs,'readv',fd,[Buffer.alloc(2),Buffer.alloc(2)],5)
    const afterVector=next(fs,fd,2)
    const written=await callback(fs,'write',fd,Buffer.from('XY'),0,2,0)
    const afterWrite=next(fs,fd,2)
    const writeVector=await callback(fs,'writev',fd,[Buffer.from('A'),Buffer.from('B')],7)
    return {scalar:scalar.buffer.toString(),afterRead,vector:vector.buffer.map(b=>b.toString()),
      afterVector,written:written.count,afterWrite,writeVector:writeVector.count,after:next(fs,fd,2)}
  }finally{fs.closeSync(fd)}
}))

test('promise file handles preserve cursor state through positioned scalar and vector operations',()=>compare(async(fs,path)=>{
  const file=await fs.promises.open(path,'r+')
  const read=async()=>{const buffer=Buffer.alloc(2,46);const {bytesRead}=await file.read(buffer,0,2,null);return {bytesRead,text:buffer.toString()}}
  try{
    const before=await read(),scalar=await file.read(Buffer.alloc(2),0,2,5),afterRead=await read()
    const vector=await file.readv([Buffer.alloc(1),Buffer.alloc(2)],6),afterVector=await read()
    const write=await file.write(Buffer.from('XY'),0,2,0),afterWrite=await read()
    const writeVector=await file.writev([Buffer.from('A'),Buffer.from('B')],4)
    return {before,scalar:scalar.buffer.toString(),afterRead,vector:vector.buffers.map(b=>b.toString()),
      afterVector,write:write.bytesWritten,afterWrite,writeVector:writeVector.bytesWritten,after:await read()}
  }finally{await file.close()}
}))

test('access-mode errors do not advance the descriptor cursor',()=>compare((fs,path)=>{
  const result={}
  withDescriptor(fs,path,'r',fd=>{
    try{fs.writeSync(fd,Buffer.from('XY'),0,2,4)}catch(error){result.write=error.code}
    result.after=next(fs,fd,2)
  })
  withDescriptor(fs,path,'w',fd=>{
    try{fs.readSync(fd,Buffer.alloc(2),0,2,0)}catch(error){result.read=error.code}
    fs.writeSync(fd,Buffer.from('XY'));result.contents=fs.readFileSync(path,'utf8')
  })
  return result
}))
