import {test,expect} from '@playwright/test'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'

const source=`
import fs,{WriteStream,createWriteStream} from 'node:fs';
import {Readable,Writable} from 'node:stream';
import {finished,pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const rows=[];
for(const path of [undefined,null,5,{}])assert.throws(()=>createWriteStream(path),{code:'ERR_INVALID_ARG_TYPE'});
for(const fail of [false,true]){
  const order=[];
  const delayed=new Writable({autoDestroy:false,construct(callback){queueMicrotask(callback)},write(chunk,encoding,callback){queueMicrotask(()=>{order.push('write');callback(fail?Object.assign(Error('write failure'),{code:'EPROBE'}):null)})},final(callback){queueMicrotask(()=>{order.push('final');callback()})}});
  delayed.end('x');
  try{await finished(delayed);order.push('finished')}catch(error){order.push(error.code)}
  rows.push(order);delayed.destroy();
}
const stream=createWriteStream('encoded',{encoding:'utf16le',highWaterMark:2});
const events=[];
for(const event of ['open','ready','finish','close'])stream.on(event,()=>events.push(event));
rows.push(stream instanceof WriteStream,stream.pending,stream.write('é'));
stream.end('😀');await finished(stream);
rows.push(fs.readFileSync('encoded').toString('hex'),stream.bytesWritten,stream.fd,stream.pending,events);

fs.writeFileSync('position','abcdef');
const fd=fs.openSync('position','r+');fs.readSync(fd,Buffer.alloc(2));
const positioned=createWriteStream(null,{fd,start:4,autoClose:false});
positioned.end('XY');await finished(positioned);
const next=Buffer.alloc(1);fs.readSync(fd,next);
rows.push(fs.readFileSync('position','utf8'),next.toString(),positioned.bytesWritten,positioned.fd===fd);
await new Promise(resolve=>{positioned.once('close',resolve);positioned.destroy()});
assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});
rows.push(positioned.fd);
const toggled=createWriteStream('toggle');toggled.autoClose=false;toggled.end('saved');
await finished(toggled);rows.push(toggled.autoClose,toggled.fd!==null,fs.readFileSync('toggle','utf8'));
await new Promise(resolve=>{toggled.once('close',resolve);toggled.destroy()});

const appended=new WriteStream('position',{flags:'a'});appended.cork();
appended.write('1');appended.write(Buffer.from('2'));appended.uncork();appended.end('3');await finished(appended);
rows.push(fs.readFileSync('position','utf8'),appended.bytesWritten);

const chunks=Array.from({length:100},(_,i)=>Buffer.alloc(3000,i));
await pipeline(Readable.from(chunks),createWriteStream('large',{highWaterMark:1024}));
rows.push(createHash('sha256').update(fs.readFileSync('large')).digest('hex'));
const closing=createWriteStream('closing',{highWaterMark:1});
for(let i=0;i<100;i++)closing.write('x');
await new Promise(resolve=>closing.close(resolve));
rows.push(closing.bytesWritten,fs.readFileSync('closing').length,closing.fd);

for(const [path,options] of [['position',{flags:'wx'}],['absent/child',{}]]){
  const failed=createWriteStream(path,options);
  try{failed.end('bad');await finished(failed);assert.fail('expected open error')}catch(error){rows.push(error.code)}
  rows.push(failed.fd);
}
const readOnly=fs.openSync('position','r');
const invalid=createWriteStream(null,{fd:readOnly});invalid.end('bad');
try{await finished(invalid);assert.fail('expected write error')}catch(error){rows.push(error.code)}
rows.push(invalid.fd);

for(let i=0;i<100;i++){
  const early=createWriteStream('early');const done=finished(early).catch(error=>assert.equal(error.code,'ERR_STREAM_PREMATURE_CLOSE'));
  early.destroy();await done;assert.equal(early.fd,null);
}
const controller=new AbortController();const aborted=createWriteStream('aborted',{signal:controller.signal});
const abortedDone=finished(aborted);controller.abort();
try{await abortedDone;assert.fail('expected abort')}catch(error){rows.push(error.name)}
rows.push(aborted.fd);
for(let i=0;i<20;i++){
  const active=createWriteStream('active');
  const original=active._write;
  active._write=function(...args){original.apply(this,args);this.destroy()};
  const done=finished(active).catch(error=>error.code);
  active.end(Buffer.alloc(4096,42));
  const error=await done;
  if(i===0)rows.push(error,active.bytesWritten,active.fd);
  assert.equal(active.fd,null);
}
console.log(JSON.stringify(rows));
`

test('file write streams match Node encoding, positions, pipelines, errors and ownership',async({page},info)=>{
  const directory=mkdtempSync(join(tmpdir(),'sandbox-write-streams-'))
  const reference=execFileSync(process.execPath,['--input-type=module','-e',source],{cwd:directory,encoding:'utf8',timeout:10000})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/main.mjs':source})
    try{return await kernel.runModule('/project/main.mjs',{cwd:'/project',webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },source)
  await info.attach('write-streams.json',{body:JSON.stringify({reference,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(reference)
})

for(const webAPIs of [false,true])test('write streams enforce permissions and recover after quota failures: Web APIs '+webAPIs,async({page},info)=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async webAPIs=>{
    const denied=`import fs from 'node:fs';import {finished} from 'node:stream/promises';
      const stream=fs.createWriteStream('/denied');stream.end('bad');
      try{await finished(stream);throw Error('permission bypass')}catch(error){if(error.code!=='EACCES')throw error}
      if(stream.fd!==null||fs.existsSync('/denied'))throw Error('denied write changed workspace');console.log('denied');`
    const quota=`import fs from 'node:fs';import assert from 'node:assert/strict';import {finished} from 'node:stream/promises';
      for(let i=0;i<20;i++){
        const stream=fs.createWriteStream('/quota');stream.end(Buffer.alloc(131072));
        await assert.rejects(finished(stream),{code:'ENOSPC'});assert.equal(stream.fd,null);fs.unlinkSync('/quota');
      }
      const recovered=fs.createWriteStream('/recovered',{autoClose:false});recovered.end('ok');await finished(recovered);
      assert.equal(fs.readFileSync('/recovered','utf8'),'ok');
      await new Promise(resolve=>{recovered.once('close',resolve);recovered.destroy()});
      const descriptors=Array.from({length:64},()=>fs.openSync('/recovered','r'));for(const fd of descriptors)fs.closeSync(fd);
      console.log('recovered');`
    const kernel=new window.sandboxLab.WorkerKernel({'/denied.mjs':denied,'/quota.mjs':quota},{workspace:{maxBytes:70000}})
    try{
      return [await kernel.runModule('/denied.mjs',{webAPIs,writable:false}),await kernel.runModule('/quota.mjs',{webAPIs,timeoutMs:15000})]
    }finally{kernel.close()}
  },webAPIs)
  await info.attach('write-stream-policy.json',{body:JSON.stringify(results),contentType:'application/json'})
  for(const result of results)expect(result.exitCode,result.stderr).toBe(0)
  expect(results.map(result=>result.stdout)).toEqual(['denied\n','recovered\n'])
})
