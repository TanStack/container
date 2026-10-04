import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {chromium,firefox,webkit} from '@playwright/test'

test('dedicated worker can dynamically import project modules served by its isolated origin service worker',async()=>{
  const serviceWorker=`self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(!url.pathname.startsWith('/_virtual/'))return;
  event.respondWith((async()=>{
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:false});
    if(clients.length!==1)return new Response('Module owner unavailable',{status:503});
    const channel=new MessageChannel();
    const result=await new Promise(resolve=>{
      const timer=setTimeout(()=>resolve({error:'Module owner timed out'}),3000);
      channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data)};
      clients[0].postMessage({type:'module-request',path:url.pathname+url.search},[channel.port2]);
    });
    channel.port1.close();
    return result.error?new Response(result.error,{status:503}):new Response(result.body,{headers:{'Content-Type':'text/javascript','Cache-Control':'no-store'}});
  })());
});`
  const worker=`self.onmessage=async({data})=>{try{
  if(data?.kind==='blob'){
    const dependency=URL.createObjectURL(new Blob(['export const value='+data.value],{type:'text/javascript'}));
    const entry=URL.createObjectURL(new Blob(['export default (await import('+JSON.stringify(dependency)+')).value+1'],{type:'text/javascript'}));
    try{const result=await import(entry);self.postMessage({value:result.default})}
    finally{URL.revokeObjectURL(entry);URL.revokeObjectURL(dependency)}
  }else{const result=await import('/_virtual/entry.js?v='+data);self.postMessage({value:result.default})}
}catch(error){self.postMessage({error:String(error)})}};`
  const serverRequests=[]
  const server=createServer((request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname
    serverRequests.push(path)
    if(path==='/sw.js'){
      response.setHeader('Content-Type','text/javascript')
      response.setHeader('Service-Worker-Allowed','/')
      response.end(serviceWorker)
    }else if(path==='/worker.js'){
      response.setHeader('Content-Type','text/javascript')
      response.end(worker)
    }else if(path==='/'){
      response.setHeader('Content-Type','text/html')
      response.end('<!doctype html><title>Isolated module origin</title>')
    }else{response.statusCode=503;response.end('No workspace attached')}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const rows=[]
    for(const browserType of [chromium,firefox,webkit]){
      serverRequests.length=0
      const browser=await browserType.launch({headless:true})
      try{
        const page=await browser.newPage()
        await page.goto(`http://127.0.0.1:${server.address().port}/`)
        await page.evaluate(async()=>{
          await navigator.serviceWorker.register('/sw.js',{scope:'/'})
          await navigator.serviceWorker.ready
          if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('Service worker did not claim page')),10000)
            navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve()},{once:true})
          })
        })
        await page.reload()
        const controlled=await page.evaluate(async()=>{
          const registration=await navigator.serviceWorker.getRegistration('/')
          const ready=await navigator.serviceWorker.ready
          if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('Reloaded page not controlled')),3000)
            navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve()},{once:true})
          }).catch(()=>{})
          return {controller:Boolean(navigator.serviceWorker.controller),registration:registration?.active?.state,ready:ready.active?.state}
        })
        console.log('module transport controlled after reload',browserType.name(),controlled)
        const result=await page.evaluate(async()=>{
          const files=new Map([
            ['/_virtual/entry.js?v=1','import {value} from "/_virtual/dependency.js?v=1";export default value+1;'],
            ['/_virtual/dependency.js?v=1','export const value=41;'],
          ])
          navigator.serviceWorker.addEventListener('message',event=>{
            if(event.data?.type==='module-request'&&event.ports[0])event.ports[0].postMessage(
              files.has(event.data.path)?{body:files.get(event.data.path)}:{error:'Unknown module'}
            )
          })
          const worker=new Worker('/worker.js',{type:'module'})
          const load=round=>new Promise(resolve=>{
            const timer=setTimeout(()=>resolve({error:'Worker module import timeout'}),10000)
            worker.onmessage=({data})=>{clearTimeout(timer);resolve(data)}
            worker.onerror=event=>{clearTimeout(timer);resolve({error:event.message})}
            worker.postMessage(round)
          })
          try{
            const first=await load(1)
            files.set('/_virtual/entry.js?v=2','import {value} from "/_virtual/dependency.js?v=2";export default value+1;')
            files.set('/_virtual/dependency.js?v=2','export const value=42;')
            const edited=await load(2)
            const blob=await load({kind:'blob',value:41})
            const editedBlob=await load({kind:'blob',value:42})
            return {first,edited,blob,editedBlob}
          }finally{worker.terminate()}
        })
        rows.push({browser:browserType.name(),result,unhandledVirtualRequests:serverRequests.filter(path=>path.startsWith('/_virtual/'))})
      }finally{await browser.close()}
    }
    console.log('isolated module transport',JSON.stringify(rows))
    for(const row of rows){
      assert.deepEqual(row.result.blob,{value:42},`${row.browser} Blob module graph`)
      assert.deepEqual(row.result.editedBlob,{value:43},`${row.browser} edited Blob module graph`)
      assert.deepEqual({first:row.result.first,edited:row.result.edited},{first:{value:42},edited:{value:43}},`${row.browser} service worker module graph`)
    }
  }finally{await new Promise(resolve=>server.close(resolve))}
})
