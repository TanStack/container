import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {chromium,firefox,webkit} from '@playwright/test'
import {installNativeWorkerIOObservation} from '../scripts/native-worker-io-observation.mjs'

test('worker I/O observation preserves real transfers and precedes owner disposal handling',{
  skip:process.env.NATIVE_WORKER_IO_BROWSER!=='1'?'Opt-in worker observer browser control':false,
  timeout:30000,
},async()=>{
  let parentOrigin
  const parent=createServer((_request,response)=>response.end('<!doctype html><title>Worker observer control</title>'))
  const owner=createServer((request,response)=>{
    if(request.url==='/worker.js'){
      response.setHeader('Content-Type','text/javascript')
      response.end(`onmessage=({data})=>{
        if(data.operation==='connect')postMessage({id:data.id,ok:true,value:{socketId:7}});
        if(data.operation==='write')postMessage({id:data.id,ok:true,value:{bytes:data.bytes.byteLength}});
      };`)
      return
    }
    response.setHeader('Content-Type','text/html')
    response.end(`<!doctype html><script>
      addEventListener('message',event=>{
        if(event.origin!==${JSON.stringify(parentOrigin)}||event.source!==parent||event.data?.protocol!=='native-owner-v1'||event.data.type!=='connect')return;
        const port=event.ports[0],worker=new Worker('/worker.js');let detached=false,originalResult=false;
        worker.onmessage=({data})=>{
          if(data.id===1){
            const bytes=new Uint8Array([1,2,3]);
            originalResult=worker.postMessage({id:2,operation:'write',socketId:7,bytes},[bytes.buffer])===undefined;
            detached=bytes.buffer.byteLength===0;
          }else if(data.id===2){
            if(data.value.bytes!==3)throw Error('Transfer contents changed');
            worker.postMessage({id:3,operation:'read',socketId:7});
            port.postMessage({type:'fixture-read-pending'});
          }
        };
        port.onmessage=({data})=>{
          if(data.operation==='fetch')worker.postMessage({id:1,operation:'connect'});
          if(data.operation==='dispose'){
            const snapshot=globalThis.__nativeWorkerIOObservation.rows.at(-1);
            port.postMessage({protocol:'native-owner-v1',type:'response',id:data.id,ok:true,value:{snapshot,detached,originalResult}});
            worker.terminate();
          }
        };
        port.start();port.postMessage({type:'fixture-connected'});
      });
    </script>`)
  })
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)))
  parentOrigin=await listen(parent)
  const ownerOrigin=await listen(owner)
  try{
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch()
      try{
        const page=await browser.newPage()
        await page.addInitScript(installNativeWorkerIOObservation,{ownerOrigin,parentOrigin})
        await page.goto(parentOrigin)
        const result=await page.evaluate(async ownerOrigin=>{
          const frame=document.createElement('iframe')
          frame.src=ownerOrigin;document.body.append(frame)
          await new Promise(resolve=>frame.onload=resolve)
          const channel=new MessageChannel()
          try{return await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('Worker observation control timed out')),5000)
            channel.port1.onmessage=({data})=>{
              if(data.type==='fixture-connected')channel.port1.postMessage({protocol:'native-owner-v1',type:'request',id:1,operation:'fetch',method:'GET'});
              if(data.type==='fixture-read-pending')channel.port1.postMessage({protocol:'native-owner-v1',type:'request',id:2,operation:'dispose'});
              if(data.type==='response'){clearTimeout(timer);resolve(data.value)}
            }
            channel.port1.start()
            frame.contentWindow.postMessage({protocol:'native-owner-v1',type:'connect'},ownerOrigin,[channel.port2])
          })}finally{channel.port1.close();frame.remove()}
        },ownerOrigin)
        assert.equal(result.originalResult,true)
        assert.equal(result.detached,true)
        assert.equal(result.snapshot.kind,'snapshot')
        assert.equal(result.snapshot.scope,'before owner handles dispose')
        assert.deepEqual(result.snapshot.pendingWorker.map(row=>row.operation),['read'])
        assert.deepEqual(result.snapshot.pendingOwner.map(row=>row.operation),['fetch','dispose'])
        assert.deepEqual(result.snapshot.sockets,[{worker:1,socketId:7}])
        assert.equal(result.snapshot.pendingDropped,0)
        console.log(JSON.stringify({browser:engine.name(),version:browser.version(),workerIOControl:'passed'}))
      }finally{await browser.close()}
    }
  }finally{await Promise.all([parent,owner].map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))))}
})
