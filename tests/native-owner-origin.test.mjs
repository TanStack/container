import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {chromium,firefox,webkit} from '@playwright/test'

function listen(server){return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)))}
function close(server){return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}

test('a separate owner origin can host a native worker and exchange a message with the app',async()=>{
  let hostOrigin=''
  let ownerOrigin=''
  const host=createServer((request,response)=>{
    if(request.url==='/host-only-marker'){
      response.setHeader('Content-Type','text/plain')
      response.end('host-only')
      return
    }
    response.setHeader('Content-Type','text/html')
    response.end(`<!doctype html><script>
      window.ownerReady=new Promise(resolve=>addEventListener('message',event=>{
        if(event.origin===${JSON.stringify(ownerOrigin)}&&event.data==='owner-ready')resolve()
      }))
    </script><iframe id="owner" src="${ownerOrigin}/owner.html"></iframe>`)
  })
  const owner=createServer((request,response)=>{
    if(request.url==='/worker.js'){
      response.setHeader('Content-Type','text/javascript')
      response.end(`self.onmessage=async({data,ports})=>{
        const port=ports[0]
        let hostFetchAllowed=false
        try{await fetch(data.hostOrigin+'/host-only-marker');hostFetchAllowed=true}catch{}
        port.postMessage({workerOrigin:location.origin,hostFetchAllowed})
      }`)
      return
    }
    response.setHeader('Content-Type','text/html')
    response.end(`<!doctype html><script>
      parent.postMessage('owner-ready',${JSON.stringify(hostOrigin)})
      addEventListener('message',event=>{
        if(event.origin!==${JSON.stringify(hostOrigin)}||event.data!=='start'||event.ports.length!==1)return
        const channel=new MessageChannel()
        const worker=new Worker('/worker.js')
        channel.port1.onmessage=message=>{event.ports[0].postMessage(message.data);worker.terminate()}
        worker.postMessage({hostOrigin:${JSON.stringify(hostOrigin)}},[channel.port2])
      })
    </script>`)
  })
  try{
    hostOrigin=await listen(host)
    ownerOrigin=await listen(owner)
    for(const browserType of [chromium,firefox,webkit]){
      const browser=await browserType.launch({headless:true})
      try{
        const page=await browser.newPage()
        await page.goto(hostOrigin)
        const result=await page.evaluate(async ownerOrigin=>{
          const frame=document.querySelector('#owner')
          await window.ownerReady
          const cannotReadFrame=(()=>{try{return frame.contentWindow.document.body===undefined}catch{return true}})()
          const channel=new MessageChannel()
          const message=new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('Owner-origin worker timed out')),10000)
            channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data)}
          })
          frame.contentWindow.postMessage('start',ownerOrigin,[channel.port2])
          return {cannotReadFrame,...await message}
        },ownerOrigin)
        assert.equal(result.cannotReadFrame,true,browserType.name())
        assert.equal(result.workerOrigin,ownerOrigin,browserType.name())
        assert.equal(result.hostFetchAllowed,false,browserType.name())
      }finally{await browser.close()}
    }
  }finally{await close(owner);await close(host)}
})
