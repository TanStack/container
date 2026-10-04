import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import {pipeline} from 'node:stream/promises'
import {Writable} from 'node:stream'
import {createNativeFilesystemAsyncApi} from '../src/native/filesystem-async-api.mjs'
import {createNativeFilesystemStreamApi} from '../src/native/filesystem-stream-api.mjs'
import {withNativeFilesystemService} from './fixtures/native-filesystem-service.mjs'

const settings={timeout:15000}
async function compare(operation){
  const directory=mkdtempSync(join(tmpdir(),'native-filesystem-stream-reference-'))
  try{
    const expected=await operation(nodeFs,directory)
    await withNativeFilesystemService(async({connect,inspect})=>{
      const {fs}=connect('streams'),{callbacks,promises}=createNativeFilesystemAsyncApi(fs)
      const api={...fs,...callbacks,...createNativeFilesystemStreamApi(callbacks),promises}
      // A remote proxy does not enumerate its methods, keep sync calls explicit.
      for(const name of ['readSync','writeSync','openSync','closeSync','readFileSync','writeFileSync','fstatSync'])
        api[name]=(...args)=>fs[name](...args)
      const actual=await operation(api,'/app')
      assert.deepEqual(actual,expected)
      assert.equal((await inspect()).descriptors,0)
    })
  }finally{
    assert.equal(nodeFs.lstatSync(directory).isSymbolicLink(),false)
    assert.equal(nodeFs.realpathSync(directory),directory.replace(/^\/var\//,'/private/var/'))
    assert.ok(directory.startsWith(join(tmpdir(),'native-filesystem-stream-reference-')))
    rmSync(directory,{recursive:true})
  }
}
const collect=stream=>new Promise((resolve,reject)=>{
  const chunks=[]
  stream.on('data',chunk=>chunks.push(chunk));stream.once('error',reject)
  stream.once('end',()=>resolve(Buffer.concat(chunks.map(chunk=>typeof chunk==='string'?Buffer.from(chunk):chunk))))
})

test('binary read streams honor backpressure and Node lifecycle order',settings,()=>compare(async(api,root)=>{
  const bytes=Buffer.alloc(200000);for(let index=0;index<bytes.length;index++)bytes[index]=index%251
  api.writeFileSync(root+'/file',bytes)
  const stream=api.createReadStream(root+'/file',{highWaterMark:8191}),events=[]
  const initial=stream.pending,closed=once(stream,'close')
  for(const event of ['open','ready','end','close'])stream.on(event,()=>events.push(event))
  let count=0,equal=true
  await pipeline(stream,new Writable({highWaterMark:1,write(chunk,encoding,done){
    equal&&=chunk.equals(bytes.subarray(count,count+chunk.length));count+=chunk.length;setTimeout(done,1)
  }}))
  await closed
  return {initial,count,equal,events,bytesRead:stream.bytesRead,fd:stream.fd,closed:stream.closed}
}))

for(const range of [{start:2,end:5},{end:3},{start:4}])
  test(`read stream range matches Node: ${JSON.stringify(range)}`,settings,()=>compare(async(api,root)=>{
    api.writeFileSync(root+'/file','abcdefghij')
    const stream=api.createReadStream(root+'/file',{...range,highWaterMark:2}),closed=once(stream,'close')
    const data=await collect(stream);await closed
    return {data:data.toString(),bytesRead:stream.bytesRead,fd:stream.fd}
  }))

test('a supplied read descriptor shares its cursor and autoClose false keeps it open',settings,()=>compare(async(api,root)=>{
  api.writeFileSync(root+'/file','abcdef')
  const fd=api.openSync(root+'/file','r'),first=Buffer.alloc(2)
  try{
    api.readSync(fd,first,0,2,null)
    const stream=api.createReadStream(undefined,{fd,autoClose:false,highWaterMark:2}),events=[]
    stream.on('open',()=>events.push('open'));stream.on('ready',()=>events.push('ready'))
    const text=(await collect(stream)).toString(),next=api.readSync(fd,Buffer.alloc(1),0,1,null)
    return {first:first.toString(),text,next,events,fd:stream.fd===fd,autoClose:stream.autoClose}
  }finally{api.closeSync(fd)}
}))

test('positioned read stream does not seek its supplied descriptor',settings,()=>compare(async(api,root)=>{
  api.writeFileSync(root+'/file','abcdef')
  const fd=api.openSync(root+'/file','r'),first=Buffer.alloc(1)
  try{
    api.readSync(fd,first,0,1,null)
    const stream=api.createReadStream(undefined,{fd,autoClose:false,start:3,end:4,highWaterMark:1})
    const text=(await collect(stream)).toString(),next=Buffer.alloc(1)
    api.readSync(fd,next,0,1,null)
    return {text,next:next.toString(),bytesRead:stream.bytesRead}
  }finally{api.closeSync(fd)}
}))

test('write streams preserve corked vector bytes and Node lifecycle order',settings,()=>compare(async(api,root)=>{
  const stream=api.createWriteStream(root+'/file',{highWaterMark:2}),events=[],closed=once(stream,'close')
  for(const event of ['open','ready','finish','close'])stream.on(event,()=>events.push(event))
  stream.cork();stream.write('hello');stream.write(' ');stream.write(Buffer.from('world'));stream.uncork();stream.end()
  await closed
  return {text:api.readFileSync(root+'/file','utf8'),bytesWritten:stream.bytesWritten,events,fd:stream.fd}
}))

test('write stream uses the supplied descriptor position without auto-closing it',settings,()=>compare(async(api,root)=>{
  api.writeFileSync(root+'/file','abcdef')
  const fd=api.openSync(root+'/file','r+'),first=Buffer.alloc(2)
  try{
    api.readSync(fd,first,0,2,null)
    const stream=api.createWriteStream(undefined,{fd,autoClose:false}),done=once(stream,'finish')
    stream.end('XY');await done
    const next=Buffer.alloc(2);api.readSync(fd,next,0,2,null)
    return {text:api.readFileSync(root+'/file','utf8'),next:next.toString(),bytesWritten:stream.bytesWritten,fd:stream.fd===fd}
  }finally{api.closeSync(fd)}
}))

test('positioned writes do not seek their supplied descriptor',settings,()=>compare(async(api,root)=>{
  api.writeFileSync(root+'/file','abcdef')
  const fd=api.openSync(root+'/file','r+')
  try{
    const stream=api.createWriteStream(undefined,{fd,start:3,autoClose:false}),done=once(stream,'finish')
    stream.end('XY');await done
    const next=Buffer.alloc(2);api.readSync(fd,next,0,2,null)
    return {text:api.readFileSync(root+'/file','utf8'),next:next.toString(),bytesWritten:stream.bytesWritten}
  }finally{api.closeSync(fd)}
}))

test('empty write streams create and close their file',settings,()=>compare(async(api,root)=>{
  const stream=api.createWriteStream(root+'/empty'),closed=once(stream,'close')
  stream.end();await closed
  return {bytes:api.readFileSync(root+'/empty').length,bytesWritten:stream.bytesWritten,fd:stream.fd}
}))

test('explicit write close finishes queued data and closes an autoClose false stream',settings,()=>compare(async(api,root)=>{
  const stream=api.createWriteStream(root+'/file',{autoClose:false}),closed=once(stream,'close')
  stream.write('hello');stream.close();await closed
  return {text:api.readFileSync(root+'/file','utf8'),bytesWritten:stream.bytesWritten,fd:stream.fd}
}))

test('read abort closes the remote descriptor and reports AbortError',settings,()=>compare(async(api,root)=>{
  api.writeFileSync(root+'/file',Buffer.alloc(200000))
  const controller=new AbortController(),stream=api.createReadStream(root+'/file',{signal:controller.signal,highWaterMark:8})
  const error=new Promise(resolve=>stream.once('error',resolve)),closed=new Promise(resolve=>stream.once('close',resolve))
  stream.once('data',()=>controller.abort());stream.resume()
  const failure=await error;await closed
  return {name:failure.name,code:failure.code,fd:stream.fd,closed:stream.closed}
}))

test('failed stream opens settle once without keeping a descriptor',settings,()=>compare(async(api,root)=>{
  const stream=api.createReadStream(root+'/missing'),events=[]
  const ended=new Promise(resolve=>stream.once('close',resolve))
  stream.on('error',error=>events.push(error.code));stream.resume();await ended
  return {events,fd:stream.fd,closed:stream.closed}
}))

for(const vector of [false,true])test(`${vector?'vector':'scalar'} stream writes retry partial writes and EAGAIN`,settings,()=>compare(async(api,root)=>{
  const calls=[]
  let waiting=true
  const fs={...api,write(fd,buffer,offset,length,pos,done){
    calls.push({pos:pos??null,bytes:[...buffer.subarray(offset,offset+length)]})
    if(waiting){waiting=false;queueMicrotask(()=>done(Object.assign(Error('busy'),{code:'EAGAIN'}),0,buffer));return}
    const count=api.writeSync(fd,buffer,offset,Math.min(length,2),pos)
    queueMicrotask(()=>done(null,count,buffer))
  },writev(fd,buffers,pos,done){this.write(fd,Buffer.concat(buffers),0,buffers.reduce((sum,b)=>sum+b.length,0),pos,
    (error,count)=>done(error,count,buffers))}}
  const stream=api.createWriteStream(root+'/file',{fs,...(vector?{}:{start:1})}),closed=once(stream,'close')
  if(vector){stream.cork();stream.write('abc');stream.write('def');stream.uncork();stream.end()}
  else stream.end('abcdef')
  await closed
  return {text:[...api.readFileSync(root+'/file')],bytesWritten:stream.bytesWritten,
    calls:calls.map(({bytes})=>bytes)}
}))

test('write stream flush calls fsync before closing',settings,()=>compare(async(api,root)=>{
  const calls=[],fs={...api,fsync(fd,done){calls.push('fsync');queueMicrotask(()=>done(null))},
    close(fd,done){calls.push('close');api.close(fd,done)}}
  const stream=api.createWriteStream(root+'/file',{fs,flush:true}),closed=once(stream,'close')
  stream.end('hello');await closed
  return {calls,text:api.readFileSync(root+'/file','utf8')}
}))

test('range and option errors are synchronous and do not start an open',settings,()=>compare(async(api,root)=>{
  let opens=0
  const fs={...api,open(){opens++}},codes=[]
  for(const args of [{start:-1},{start:5,end:2},{end:1.5},{fd:'wrong'},{fs:{}}]){
    try{api.createReadStream(root+'/file',{...args,fs:args.fs??fs})}catch(error){codes.push(error.code)}
  }
  await new Promise(resolve=>setTimeout(resolve,1))
  return {codes,opens}
}))

for(const writing of [false,true])test(`destroy waits for pending ${writing?'write':'read'} before closing the descriptor`,settings,
  ()=>compare(async(api,root)=>{
    api.writeFileSync(root+'/file','abcdef')
    const events=[]
    let stream
    const fs={...api,read(fd,buffer,offset,length,pos,done){
      stream.destroy();setTimeout(()=>{const count=api.readSync(fd,buffer,offset,length,pos);events.push('read');done(null,count,buffer)},1)
    },write(fd,buffer,offset,length,pos,done){
      stream.destroy();setTimeout(()=>{const count=api.writeSync(fd,buffer,offset,length,pos);events.push('write');done(null,count,buffer)},1)
    },close(fd,done){events.push('close');api.close(fd,done)}}
    stream=writing?api.createWriteStream(root+'/file',{fs}):api.createReadStream(root+'/file',{fs})
    const closed=new Promise(resolve=>stream.once('close',resolve)),errors=[]
    stream.on('error',error=>errors.push(error.code))
    if(writing)stream.end('hello');else stream.resume()
    await closed
    return {events,errors,fd:stream.fd,closed:stream.closed}
  }))

test('positioned partial vector writes retain every byte and do not seek the descriptor',settings,
  ()=>withNativeFilesystemService(async({connect,inspect})=>{
    const {fs}=connect('partial-vector'),{callbacks}=createNativeFilesystemAsyncApi(fs)
    fs.writeFileSync('/app/file','0123456789')
    const fd=fs.openSync('/app/file','r+'),calls=[],custom={...callbacks,writev(fd,buffers,pos,done){
      const bytes=Buffer.concat(buffers);calls.push(pos)
      const count=fs.writeSync(fd,bytes,0,Math.min(bytes.length,2),pos)
      queueMicrotask(()=>done(null,count,buffers))
    }}
    const stream=callbacks.createWriteStream(undefined,{fd,fs:custom,start:1,autoClose:false}),done=once(stream,'finish')
    try{
      stream.cork();stream.write('abc');stream.write('def');stream.uncork();stream.end();await done
      assert.deepEqual(calls,[1,3,5])
      assert.equal(fs.readFileSync('/app/file','utf8'),'0abcdef789')
      const next=Buffer.alloc(1);fs.readSync(fd,next,0,1,null);assert.equal(next.toString(),'0')
      assert.equal(stream.bytesWritten,6)
    }finally{fs.closeSync(fd)}
    assert.equal((await inspect()).descriptors,0)
  }))

test('a writer that makes no progress settles with an error and closes once',settings,()=>compare(async(api,root)=>{
  let writes=0,closes=0
  const fs={...api,write(fd,buffer,offset,length,pos,done){writes++;queueMicrotask(()=>done(null,0,buffer))},
    close(fd,done){closes++;api.close(fd,done)}}
  const stream=api.createWriteStream(root+'/file',{fs}),closed=new Promise(resolve=>stream.once('close',resolve))
  let code;stream.once('error',error=>{code=error.code});stream.end('hello');await closed
  return {writes,closes,code,fd:stream.fd}
}))

for(const form of ['buffer','url','localhost'])test(`stream paths accept ${form} paths like Node`,settings,()=>compare(async(api,root)=>{
  const target=root+'/file',value=form==='buffer'?Buffer.from(target):new URL('file://'+(form==='localhost'?'localhost':'')+target)
  const writer=api.createWriteStream(value,'utf8'),written=once(writer,'close');writer.end('hello');await written
  const reader=api.createReadStream(value,'utf8'),closed=once(reader,'close')
  const text=await collect(reader);await closed
  return text.toString()
}))

test('a write-only callback provider also accepts corked writes',settings,()=>compare(async(api,root)=>{
  const fs={open:api.open,write:api.write,close:api.close}
  const stream=api.createWriteStream(root+'/file',{fs}),closed=once(stream,'close')
  stream.cork();stream.write('hello');stream.write(' world');stream.uncork();stream.end();await closed
  return {text:api.readFileSync(root+'/file','utf8'),bytesWritten:stream.bytesWritten}
}))

test('a writev-only callback provider also accepts scalar writes',settings,()=>withNativeFilesystemService(async({connect,inspect})=>{
  const {fs}=connect('writev-only'),{callbacks}=createNativeFilesystemAsyncApi(fs)
  const operations={open:callbacks.open,writev:callbacks.writev,close:callbacks.close}
  const stream=callbacks.createWriteStream('/app/file',{fs:operations}),closed=once(stream,'close')
  stream.end('hello');await closed
  assert.equal(fs.readFileSync('/app/file','utf8'),'hello');assert.equal(stream.bytesWritten,5)
  assert.equal((await inspect()).descriptors,0)
}))

for(const autoClose of [false,true])test(`read errors respect autoClose ${autoClose}`,settings,()=>compare(async(api,root)=>{
  api.writeFileSync(root+'/file','hello')
  const fs={...api,read(fd,buffer,offset,length,pos,done){queueMicrotask(()=>done(Object.assign(Error('io failed'),{code:'EIO'})))}}
  const stream=api.createReadStream(root+'/file',{fs,autoClose}),failure=new Promise(resolve=>stream.once('error',resolve))
  const ended=autoClose?new Promise(resolve=>stream.once('close',resolve)):undefined
  stream.resume();const error=await failure
  if(ended)await ended
  const result={code:error.code,fdOpen:stream.fd!==null,closed:stream.closed}
  if(!autoClose)api.closeSync(stream.fd)
  return result
}))

for(const encoding of ['utf16le','latin1'])test(`writer encoding ${encoding} matches Node`,settings,()=>compare(async(api,root)=>{
  const writer=api.createWriteStream(root+'/file',{encoding}),closed=once(writer,'close')
  writer.end('é雪');await closed
  return [...api.readFileSync(root+'/file')]
}))

for(const writing of [false,true])test(`supplied promise file handles support ${writing?'writes':'reads'} and auto-close`,settings,
  ()=>compare(async(api,root)=>{
    api.writeFileSync(root+'/file','abcdef')
    // The remote side uses its own handle class, the reference uses real Node.
    const handle=await api.promises.open(root+'/file','r+')
    let stream
    try{
      stream=writing?api.createWriteStream(undefined,{fd:handle,start:2}):api.createReadStream(undefined,{fd:handle,start:2,end:4})
      const closed=once(stream,'close')
      let text
      if(writing){stream.end('XY');await closed;text=api.readFileSync(root+'/file','utf8')}
      else{text=(await collect(stream)).toString();await closed}
      return {text,fd:handle.fd,streamFd:stream.fd}
    }finally{if(handle.fd!==-1)await handle.close()}
  }))
