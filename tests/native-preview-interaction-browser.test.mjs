import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {chromium,firefox,webkit} from '@playwright/test'
import {installNativePreviewInteractionObservation} from '../scripts/native-preview-interaction-observation.mjs'

test('interaction metadata distinguishes delivered clicks from deferred handler installation',{
  skip:process.env.NATIVE_PREVIEW_INTERACTION_CONTROL!=='1'?'Opt-in desktop interaction control':false,
  timeout:60000,
},async()=>{
  let release
  const server=createServer((request,response)=>{
    if(request.url==='/gate'){
      release=()=>{response.writeHead(200);response.end('ready')}
      return
    }
    response.writeHead(200,{'Content-Type':'text/html'})
    response.end(`<!doctype html><button>Count</button><output>0</output><script type="module">
      await fetch('/gate');
      document.querySelector('button').onclick=()=>{
        const output=document.querySelector('output');output.textContent=String(Number(output.textContent)+1)
      };
      globalThis.handlerInstalled=true;
    </script>`)
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  try{for(const engine of [chromium,firefox,webkit]){
    release=undefined
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      await page.addInitScript(installNativePreviewInteractionObservation,{previewOrigin:origin})
      await page.goto(origin,{waitUntil:'commit'})
      await page.waitForSelector('button')
      const before=await page.evaluate(()=>{
        document.querySelector('button').click()
        return {count:document.querySelector('output').textContent,
          snapshot:globalThis.__nativePreviewInteractionObservation.snapshot()}
      })
      assert.equal(before.count,'0',engine.name())
      assert.deepEqual(before.snapshot.rows.filter(r=>r.kind.startsWith('click-')).map(r=>r.kind),
        ['click-call','click-capture','click-bubble','click-return'],engine.name())
      // Wait for the server to receive the original module request, not a timer.
      if(!release)await new Promise(resolve=>{
        const onRequest=request=>{if(request.url==='/gate'){server.off('request',onRequest);resolve()}}
        server.on('request',onRequest)
        if(release){server.off('request',onRequest);resolve()}
      })
      release()
      await page.waitForFunction(()=>globalThis.handlerInstalled===true)
      const after=await page.evaluate(()=>{
        document.querySelector('button').click()
        return {count:document.querySelector('output').textContent,
          snapshot:globalThis.__nativePreviewInteractionObservation.snapshot()}
      })
      assert.equal(after.count,'1',engine.name())
      assert.equal(after.snapshot.rows.filter(r=>r.kind==='click-call').length,2)
      assert.equal(after.snapshot.dropped,0)
      console.log(JSON.stringify({browser:engine.name(),version:browser.version(),earlyClick:before.count,
        installedHandlerClick:after.count,earlyReadyState:before.snapshot.rows.at(-1).readyState,passed:true}))
    }finally{await browser.close()}
  }}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
