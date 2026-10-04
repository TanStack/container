import {Buffer} from 'buffer'
import {Writable,pipeline} from 'readable-stream'
import {createNativeFilesystemAsyncApi} from '../../src/native/filesystem-async-api.mjs'

export async function runFilesystemStreamControl(fs,callbacks=createNativeFilesystemAsyncApi(fs).callbacks){
  const checks=[]
  const check=(condition,label)=>{if(!condition)throw Error(label);checks.push(label)}
  const closed=stream=>new Promise((resolve,reject)=>{stream.once('close',resolve);stream.once('error',reject)})
  const collect=stream=>new Promise((resolve,reject)=>{
    const chunks=[];stream.on('data',chunk=>chunks.push(chunk));stream.once('error',reject)
    stream.once('end',()=>resolve(Buffer.concat(chunks)))
  })
  const finish=stream=>new Promise((resolve,reject)=>{stream.once('finish',resolve);stream.once('error',reject)})
  const bytes=Buffer.alloc(200000);for(let index=0;index<bytes.length;index++)bytes[index]=index%251
  fs.writeFileSync('/app/stream.bin',bytes)
  const source=callbacks.createReadStream('/app/stream.bin',{highWaterMark:8191}),events=[]
  for(const event of ['open','ready','end','close'])source.on(event,()=>events.push(event))
  let count=0,equal=true
  await new Promise((resolve,reject)=>pipeline(source,new Writable({highWaterMark:1,write(chunk,encoding,done){
    equal&&=chunk.equals(bytes.subarray(count,count+chunk.length));count+=chunk.length;setTimeout(done,1)
  }}),error=>error?reject(error):resolve()))
  check(equal&&count===bytes.length&&source.bytesRead===count,'backpressure retains all binary bytes')
  check(events.join(',')==='open,ready,end,close'&&source.fd===null,'read lifecycle and descriptor cleanup')
  fs.writeFileSync('/app/stream.txt','abcdefghij')
  const range=callbacks.createReadStream('/app/stream.txt',{start:2,end:5,highWaterMark:2}),rangeClosed=closed(range)
  check((await collect(range)).toString()==='cdef','inclusive stream range');await rangeClosed
  const fd=fs.openSync('/app/stream.txt','r'),first=Buffer.alloc(2)
  try{
    fs.readSync(fd,first,0,2,null)
    const reader=callbacks.createReadStream(undefined,{fd,autoClose:false})
    check((await collect(reader)).toString()==='cdefghij'&&reader.fd===fd,'supplied descriptor cursor and autoClose false')
  }finally{fs.closeSync(fd)}
  const positioned=fs.openSync('/app/stream.txt','r')
  try{
    const reader=callbacks.createReadStream(undefined,{fd:positioned,autoClose:false,start:5,end:6}),next=Buffer.alloc(1)
    const data=await collect(reader);fs.readSync(positioned,next,0,1,null)
    check(data.toString()==='fg'&&next.toString()==='a','positioned stream leaves descriptor cursor unchanged')
  }finally{fs.closeSync(positioned)}
  const writer=callbacks.createWriteStream('/app/stream-write.txt'),writerClosed=closed(writer)
  writer.cork();writer.write('hello');writer.write(' ');writer.write('world');writer.uncork();writer.end();await writerClosed
  check(fs.readFileSync('/app/stream-write.txt','utf8')==='hello world'&&writer.bytesWritten===11,'corked vector stream bytes')
  let busy=true
  const partial={...callbacks,write(fd,buffer,offset,length,pos,done){
    if(busy){busy=false;queueMicrotask(()=>done(Object.assign(Error('busy'),{code:'EAGAIN'}),0,buffer));return}
    const count=fs.writeSync(fd,buffer,offset,Math.min(length,2),pos);queueMicrotask(()=>done(null,count,buffer))
  }}
  const scalar=callbacks.createWriteStream('/app/partial.txt',{fs:partial,start:1}),scalarClosed=closed(scalar)
  scalar.end('abcdef');await scalarClosed
  check(fs.readFileSync('/app/partial.txt').equals(Buffer.from([0,97,98,99,100,101,102]))&&scalar.bytesWritten===6,
    'partial scalar write retries EAGAIN without losing bytes')
  fs.writeFileSync('/app/partial-vector.txt','0123456789')
  const vectorFd=fs.openSync('/app/partial-vector.txt','r+'),positions=[]
  try{
    const vector=callbacks.createWriteStream(undefined,{fd:vectorFd,start:1,autoClose:false,fs:{...callbacks,
      writev(fd,buffers,pos,done){const bytes=Buffer.concat(buffers);positions.push(pos)
        const count=fs.writeSync(fd,bytes,0,Math.min(bytes.length,2),pos);queueMicrotask(()=>done(null,count,buffers))}}})
    const done=finish(vector);vector.cork();vector.write('abc');vector.write('def');vector.uncork();vector.end();await done
    const next=Buffer.alloc(1);fs.readSync(vectorFd,next,0,1,null)
    check(fs.readFileSync('/app/partial-vector.txt','utf8')==='0abcdef789'&&positions.join(',')==='1,3,5'&&next.toString()==='0',
      'partial positioned vector write preserves bytes and cursor')
  }finally{fs.closeSync(vectorFd)}
  const empty=callbacks.createWriteStream('/app/empty.txt'),emptyClosed=closed(empty);empty.end();await emptyClosed
  check(fs.readFileSync('/app/empty.txt').length===0&&empty.fd===null,'empty write opens and closes its file')
  const controller=new AbortController(),aborted=callbacks.createReadStream('/app/stream.bin',{signal:controller.signal,highWaterMark:8})
  const failure=new Promise(resolve=>aborted.once('error',resolve)),abortClosed=new Promise(resolve=>aborted.once('close',resolve))
  aborted.once('data',()=>controller.abort());aborted.resume();const error=await failure;await abortClosed
  check(error.name==='AbortError'&&error.code==='ABORT_ERR'&&aborted.fd===null,'aborted stream closes its descriptor')
  const missing=callbacks.createReadStream('/app/missing-stream-file'),errors=[]
  const missingClosed=new Promise(resolve=>missing.once('close',resolve));missing.on('error',error=>errors.push(error.code))
  missing.resume();await missingClosed
  check(errors.join(',')==='ENOENT'&&missing.fd===null,'failed open settles once')
  const explicit=callbacks.createWriteStream('/app/explicit.txt',{autoClose:false}),explicitClosed=closed(explicit)
  explicit.write('queued');explicit.close();await explicitClosed
  check(fs.readFileSync('/app/explicit.txt','utf8')==='queued'&&explicit.fd===null,'explicit close finishes queued writes')
  const order=[],flushed=callbacks.createWriteStream('/app/flushed.txt',{flush:true,fs:{...callbacks,
    fsync(fd,done){order.push('fsync');callbacks.fsync(fd,done)},close(fd,done){order.push('close');callbacks.close(fd,done)}}})
  const flushedClosed=closed(flushed);flushed.end('flushed');await flushedClosed
  check(order.join(',')==='fsync,close'&&fs.readFileSync('/app/flushed.txt','utf8')==='flushed','flush precedes descriptor close')
  let code
  try{callbacks.createReadStream('/app/stream.txt',{start:-1})}catch(error){code=error.code}
  check(code==='ERR_OUT_OF_RANGE','invalid range rejected before opening a descriptor')
  return {checks,passed:true}
}
