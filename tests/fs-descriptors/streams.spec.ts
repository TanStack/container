import {test,expect} from '@playwright/test'

test('file read streams preserve ranges, ownership, backpressure and cleanup',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`import fs from 'node:fs';import assert from 'node:assert/strict';import {finished} from 'node:stream/promises';
      fs.writeFileSync('/data','abcdef');
      const stream=fs.createReadStream('/data',{start:1,end:3,highWaterMark:1,encoding:'utf8'});
      assert.equal(typeof stream.on,'function',JSON.stringify({name:stream.constructor.name,keys:Object.keys(stream),prototype:Object.getOwnPropertyNames(Object.getPrototypeOf(stream))}));
      const events=[];stream.on('open',()=>events.push('open'));stream.on('ready',()=>events.push('ready'));
      let text='';for await(const chunk of stream)text+=chunk;
      assert.equal(text,'bcd');assert.equal(stream.bytesRead,3);assert.equal(stream.fd,null);assert.deepEqual(events,['open','ready']);
      const fd=fs.openSync('/data','r');fs.readSync(fd,Buffer.alloc(2));
      const owned=fs.createReadStream(null,{fd,autoClose:false,encoding:'utf8'});text='';for await(const chunk of owned)text+=chunk;
      assert.equal(text,'cdef');assert.equal(fs.fstatSync(fd).size,6);fs.closeSync(fd);
      const missing=fs.createReadStream('/missing');await assert.rejects(finished(missing),{code:'ENOENT'});
      for(let i=0;i<100;i++){const s=fs.createReadStream('/data');const done=finished(s).catch(e=>assert.equal(e.code,'ERR_STREAM_PREMATURE_CLOSE'));s.destroy();await done;assert.equal(s.fd,null)}
      const controller=new AbortController();const aborted=fs.createReadStream('/data',{signal:controller.signal});const done=finished(aborted);controller.abort();await assert.rejects(done,{name:'AbortError'});
      fs.writeFileSync('/large',Buffer.alloc(200000,42));const paused=fs.createReadStream('/large',{highWaterMark:1024});
      await new Promise(resolve=>paused.once('readable',resolve));assert.ok(paused.readableLength<=1024);assert.ok(paused.bytesRead<=1024);
      const stopped=finished(paused).catch(e=>assert.equal(e.code,'ERR_STREAM_PREMATURE_CLOSE'));paused.destroy();await stopped;
      console.log('file streams passed');`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{webAPIs:true})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('file streams passed\n')
})
