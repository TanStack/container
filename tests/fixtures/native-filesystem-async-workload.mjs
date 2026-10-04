import {Buffer} from 'buffer'
import {createNativeFilesystemAsyncApi} from '../../src/native/filesystem-async-api.mjs'

export async function runFilesystemAsyncControl(fs,api=createNativeFilesystemAsyncApi(fs)){
  const {callbacks,promises}=api,checks=[]
  const check=(condition,label)=>{if(!condition)throw Error(label);checks.push(label)}
  const call=(name,...args)=>new Promise((resolve,reject)=>callbacks[name](...args,
    (error,...values)=>error?reject(error):resolve(values)))
  await promises.writeFile('/app/async.bin','abcdef')
  const [fd]=await call('open','/app/async.bin','r+')
  try{
    const bytes=Buffer.alloc(5,45)
    const [count,returned]=await call('read',fd,bytes,{offset:1,length:3,position:1})
    check(count===3&&returned===bytes&&bytes.toString()==='-bcd-','callback read buffer identity and offset')
    const next=Buffer.alloc(2);await call('read',fd,next,0,2,null)
    check(next.toString()==='ab','callback positioned read preserves cursor')
    const vectors=[Buffer.from('X'),Buffer.from('Y')]
    const [written,same]=await call('writev',fd,vectors,4)
    check(written===2&&same===vectors,'callback vector write identity')
    check(await promises.readFile('/app/async.bin','utf8')==='abcdXY','callback vector write bytes')
    const storage=Buffer.alloc(5,45),read=[storage.subarray(0,3),storage.subarray(1,4)]
    const [readCount,readSame]=await call('readv',fd,read,0)
    check(readCount===6&&readSame===read&&storage.toString()==='adXY-','callback overlapping vector read')
  }finally{await call('close',fd)}
  await promises.writeFile('/app/async.bin','abcdef')
  const handle=await promises.open('/app/async.bin','r+')
  try{
    const first=Buffer.alloc(2);await handle.read(first,0,2,null)
    const second=Buffer.alloc(2);fs.readSync(handle.fd,second,0,2,null)
    check(first.toString()==='ab'&&second.toString()==='cd','promise handle shares raw descriptor')
    check(await handle.readFile('utf8')==='ef','promise whole-file read uses cursor')
    await handle.truncate(3);await handle.chmod(0o640);await handle.sync();await handle.datasync()
    const stat=await handle.stat({bigint:true})
    check(stat.size===3n&&(stat.mode&0o777n)===0o640n&&stat.isFile(),'promise descriptor metadata')
  }finally{await handle.close()}
  await promises.writeFile('/app/async.bin','abcdef')
  const writer=await promises.open('/app/async.bin','r+')
  try{
    await writer.read(Buffer.alloc(2),0,2,null)
    await promises.writeFile(writer,'XY')
    check(await promises.readFile(writer,'utf8')==='ef','promise APIs accept file handle')
    check(await promises.readFile('/app/async.bin','utf8')==='abXYef','whole-file write preserves host cursor')
  }finally{await writer.close()}
  const closing=await promises.open('/app/async.bin','r'),buffer=Buffer.alloc(2)
  let closes=0;closing.on('close',()=>closes++)
  const pending=closing.read(buffer,0,2,null),closed=closing.close()
  check((await pending).bytesRead===2&&buffer.toString()==='ab','read queued before close completes')
  await closed;await closing.close()
  check(closes===1&&closing.fd===-1,'repeated close releases descriptor once')
  let code
  try{await closing.stat()}catch(error){code=error.code}
  check(code==='EBADF','closed promise handle rejects')
  let synchronous=true
  const error=new Promise(resolve=>callbacks.stat('/app/async-missing',error=>{
    check(!synchronous&&error.code==='ENOENT','callback errors arrive asynchronously');resolve()
  }))
  synchronous=false;await error
  return {checks,passed:true}
}
