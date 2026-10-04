import test from 'node:test'
import assert from 'node:assert/strict'
import {AsyncLocalStorage,AsyncResource} from 'node:async_hooks'
import {mkdtempSync,rmSync} from 'node:fs'
import nodeFs from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createNativeFilesystemAsyncApi} from '../src/native/filesystem-async-api.mjs'
import {withNativeFilesystemService} from './fixtures/native-filesystem-service.mjs'

const settings={timeout:15000}
const call=(api,method,...args)=>new Promise((resolve,reject)=>{
  api[method](...args,(error,...values)=>error?reject(error):resolve(values))
})
async function compare(fn){
  const directory=mkdtempSync(join(tmpdir(),'native-filesystem-async-reference-'))
  try{
    const expected=await fn(nodeFs,nodeFs.promises,directory)
    await withNativeFilesystemService(async({connect,inspect})=>{
      const {fs}=connect('async'),{callbacks,promises}=createNativeFilesystemAsyncApi(fs)
      const actual=await fn(callbacks,promises,'/app',fs)
      assert.deepEqual(actual,expected)
      assert.equal((await inspect()).descriptors,0)
    })
  }finally{
    // This exact directory was created by this fixture and contains only its files.
    assert.equal(nodeFs.lstatSync(directory).isSymbolicLink(),false)
    assert.equal(nodeFs.realpathSync(directory),directory.replace(/^\/var\//,'/private/var/'))
    assert.ok(directory.startsWith(join(tmpdir(),'native-filesystem-async-reference-')))
    rmSync(directory,{recursive:true})
  }
}

test('callback path operations share one remote filesystem and match Node',settings,()=>compare(async(api,promises,root)=>{
  await call(api,'mkdir',root+'/nested',{recursive:true})
  const write=await call(api,'writeFile',root+'/nested/file','hello')
  await call(api,'appendFile',root+'/nested/file',' world')
  const [text]=await call(api,'readFile',root+'/nested/file','utf8')
  const [entries]=await call(api,'readdir',root+'/nested')
  await call(api,'rename',root+'/nested/file',root+'/nested/moved')
  await call(api,'copyFile',root+'/nested/moved',root+'/nested/copy')
  const [stat]=await call(api,'stat',root+'/nested/copy',{bigint:true})
  return {write,text,entries,size:stat.size,file:stat.isFile()}
}))

for(const options of [false,true])test(`callback read keeps the original destination, ${options?'options':'positional'} overload`,settings,()=>compare(async(api,promises,root)=>{
  await promises.writeFile(root+'/file','abcdef')
  const [fd]=await call(api,'open',root+'/file','r')
  try{
    const buffer=Buffer.alloc(8,45)
    const [count,returned]=options?await call(api,'read',fd,buffer,{offset:2,length:3,position:1}):
      await call(api,'read',fd,buffer,2,3,1)
    const next=Buffer.alloc(2)
    const [implicit]=await call(api,'read',fd,next,0,2,null)
    return {count,same:returned===buffer,bytes:[...buffer],implicit,next:[...next]}
  }finally{await call(api,'close',fd)}
}))

test('callback read allocation and buffer options match Node',settings,()=>compare(async(api,promises,root)=>{
  await promises.writeFile(root+'/file','abcdef')
  const [fd]=await call(api,'open',root+'/file','r')
  try{
    const [count,buffer]=await call(api,'read',fd,{length:3,position:1})
    return {count,buffer:Buffer.isBuffer(buffer),size:buffer.length,text:buffer.subarray(0,count).toString()}
  }finally{await call(api,'close',fd)}
}))

for(const string of [false,true])test(`callback ${string?'string':'buffer'} writes preserve the descriptor cursor`,settings,()=>compare(async(api,promises,root)=>{
  await promises.writeFile(root+'/file','abcdef')
  const [fd]=await call(api,'open',root+'/file','r+')
  try{
    const data=string?'XY':Buffer.from('XY'),args=string?[2,'utf8']:[0,2,2]
    const [count,returned]=await call(api,'write',fd,data,...args)
    const buffer=Buffer.alloc(2);await call(api,'read',fd,buffer,0,2,null)
    return {count,same:returned===data,read:buffer.toString(),text:await promises.readFile(root+'/file','utf8')}
  }finally{await call(api,'close',fd)}
}))

test('callback vector reads keep destination identity and overlapping views',settings,()=>compare(async(api,promises,root)=>{
  await promises.writeFile(root+'/file','abcdef')
  const [fd]=await call(api,'open',root+'/file','r')
  try{
    const buffer=Buffer.alloc(5,45),vectors=[buffer.subarray(0,3),buffer.subarray(1,4)]
    const [count,returned]=await call(api,'readv',fd,vectors,0)
    const next=Buffer.alloc(2);await call(api,'read',fd,next,0,2,null)
    return {count,same:returned===vectors,bytes:[...buffer],next:next.toString()}
  }finally{await call(api,'close',fd)}
}))

test('callback vector writes preserve the descriptor cursor and original vector array',settings,()=>compare(async(api,promises,root)=>{
  await promises.writeFile(root+'/file','abcdef')
  const [fd]=await call(api,'open',root+'/file','r+')
  try{
    const vectors=[Buffer.from('XY'),Buffer.from('Z')]
    const [count,returned]=await call(api,'writev',fd,vectors,2)
    const next=Buffer.alloc(2);await call(api,'read',fd,next,0,2,null)
    return {count,same:returned===vectors,next:next.toString(),text:await promises.readFile(root+'/file','utf8')}
  }finally{await call(api,'close',fd)}
}))

test('file handles share the host descriptor rather than a shadow position',settings,()=>compare(async(api,promises,root,sync=nodeFs)=>{
  await promises.writeFile(root+'/file','abcdef')
  const handle=await promises.open(root+'/file','r+')
  try{
    const one=Buffer.alloc(2);await handle.read(one,0,2,null)
    const two=Buffer.alloc(2);sync.readSync(handle.fd,two,0,2,null)
    const three=Buffer.alloc(2);await handle.read(three,0,2,null)
    return [one.toString(),two.toString(),three.toString()]
  }finally{await handle.close()}
}))

test('file handle vector operations retain cursor and caller buffers',settings,()=>compare(async(api,promises,root)=>{
  await promises.writeFile(root+'/file','abcdef')
  const handle=await promises.open(root+'/file','r+')
  try{
    const write=[Buffer.from('XY'),Buffer.from('Z')],written=await handle.writev(write,2)
    const read=[Buffer.alloc(1),Buffer.alloc(1)],result=await handle.readv(read)
    return {written:written.bytesWritten,writeSame:written.buffers===write,read:result.bytesRead,
      readSame:result.buffers===read,text:read.map(value=>value.toString()).join('')}
  }finally{await handle.close()}
}))

test('file handle reads queued before close complete, repeated close is harmless',settings,()=>compare(async(api,promises,root)=>{
  await promises.writeFile(root+'/file','abcdef')
  const handle=await promises.open(root+'/file','r'),buffer=Buffer.alloc(2)
  let closed=0;handle.on('close',()=>closed++)
  const read=handle.read(buffer,0,2,null),closing=handle.close()
  const {bytesRead}=await read;await closing;await handle.close()
  let code
  try{await handle.stat()}catch(error){code=error.code}
  return {bytesRead,text:buffer.toString(),closed,fd:handle.fd,code}
}))

test('file handle metadata and whole-file APIs use the same remote descriptor',settings,()=>compare(async(api,promises,root)=>{
  await promises.writeFile(root+'/file','abcdef')
  const handle=await promises.open(root+'/file','r+')
  try{
    const buffer=Buffer.alloc(2);await handle.read(buffer,0,2,null)
    const remaining=await handle.readFile('utf8')
    await handle.truncate(3);await handle.chmod(0o640);await handle.sync();await handle.datasync()
    const stat=await handle.stat({bigint:true})
    return {remaining,size:stat.size,mode:stat.mode&0o777n,file:stat.isFile()}
  }finally{await handle.close()}
}))

test('promise file APIs accept their own file handles and preserve position',settings,()=>compare(async(api,promises,root)=>{
  await promises.writeFile(root+'/file','abcdef')
  const handle=await promises.open(root+'/file','r+')
  try{
    const buffer=Buffer.alloc(2);await handle.read(buffer,0,2,null)
    await promises.writeFile(handle,'XY')
    const remaining=await promises.readFile(handle,'utf8')
    return {remaining,text:await promises.readFile(root+'/file','utf8')}
  }finally{await handle.close()}
}))

test('callbacks run later, preserve errors and use their creation async context',settings,()=>withNativeFilesystemService(async({connect})=>{
  const {fs}=connect('context'),store=new AsyncLocalStorage(),resources=[]
  const {callbacks}=createNativeFilesystemAsyncApi(fs,{createAsyncResource:type=>{
    const resource=new AsyncResource(type);resources.push(resource);return resource
  }})
  const order=[]
  let original
  try{fs.statSync('/missing')}catch(error){original=error}
  const result=store.run('created',()=>new Promise(resolve=>callbacks.stat('/missing',(error)=>{
    order.push('callback');resolve({code:error.code,syscall:error.syscall,path:error.path,context:store.getStore()})
  })))
  order.push('returned')
  assert.deepEqual(await store.run('other',()=>result),{code:original.code,syscall:original.syscall,path:original.path,context:'created'})
  assert.deepEqual(order,['returned','callback']);assert.equal(resources.length,1)
  assert.throws(()=>callbacks.stat('/app'),TypeError)
}))

test('promise glob returns an async iterator and matches Node entries',settings,()=>compare(async(api,promises,root)=>{
  await promises.mkdir(root+'/nested')
  await promises.writeFile(root+'/one.js','one');await promises.writeFile(root+'/two.txt','two')
  await promises.writeFile(root+'/nested/three.js','three')
  const iterator=promises.glob(['*.js','nested/*.js'],{cwd:root})
  const iterable=typeof iterator[Symbol.asyncIterator]==='function'
  return {iterable,entries:(await Array.fromAsync(iterator)).sort()}
}))
