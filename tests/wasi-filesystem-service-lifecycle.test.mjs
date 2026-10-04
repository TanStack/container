import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {Worker,MessageChannel} from 'node:worker_threads'

test('a compiler request settles when its direct filesystem service disappears', {timeout:10000},async()=>{
  const service=new Worker(`
    const {parentPort}=require('node:worker_threads');
    parentPort.once('message',({port})=>{
      port.on('message',message=>parentPort.postMessage({type:'request',method:message.__fs__.type}));
      port.start();parentPort.postMessage({type:'ready'});
    });
  `,{eval:true})
  const client=new Worker(`
    const {parentPort}=require('node:worker_threads');
    parentPort.once('message',async({port,url})=>{
      const {connectWasiFilesystemPort,createWasiFilesystemClient}=await import(url);
      const disconnect=connectWasiFilesystemPort(port);
      const fs=createWasiFilesystemClient({}, {timeoutMs:1000,decodeValue(){throw Error('Unexpected reply')}});
      const started=performance.now();
      try{fs.readFileSync('/app/file');parentPort.postMessage({type:'unexpected-success'})}
      catch(error){parentPort.postMessage({type:'result',code:error.code,message:error.message,elapsedMs:performance.now()-started})}
      finally{disconnect();parentPort.close()}
    });
  `,{eval:true})
  const {port1,port2}=new MessageChannel(),signal=AbortSignal.timeout(5000)
  try{
    const ready=once(service,'message',{signal})
    service.postMessage({port:port1},[port1])
    assert.deepEqual((await ready)[0],{type:'ready'})
    const received=once(service,'message',{signal}),result=once(client,'message',{signal})
    client.postMessage({port:port2,url:new URL('../src/native/wasi-fs-transport.mjs',import.meta.url).href},[port2])
    assert.deepEqual((await received)[0],{type:'request',method:'readFileSync'})
    await service.terminate()
    const [reply]=await result
    assert.equal(reply.type,'result')
    assert.equal(reply.code,'ERR_WASI_FILESYSTEM_TIMEOUT')
    assert.equal(reply.message,'WASI filesystem request timed out')
    assert.ok(reply.elapsedMs<5000)
  }finally{
    port1.close();port2.close()
    await Promise.all([service.terminate(),client.terminate()])
  }
})
