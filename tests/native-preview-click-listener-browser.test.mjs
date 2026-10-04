import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {join,resolve} from 'node:path'
import {installNativePreviewClickListenerObservation} from '../scripts/native-preview-click-listener-observation.mjs'

function nativeCases(){
  const target=new EventTarget(),receiver=[]
  let calls=0,typeReads=0,optionReads=0
  const callback=function(event){calls++;receiver.push(this===target&&event.type==='click')}
  const type={toString(){typeReads++;return 'click'}}
  const options={get capture(){optionReads++;return false}}
  target.addEventListener(type,callback,options);target.addEventListener(type,callback,options)
  target.dispatchEvent(new Event('click'))
  target.removeEventListener('click',callback,options);target.dispatchEvent(new Event('click'))
  let objectCalls=0,objectReads=0,objectReceiver=true
  const object={get handleEvent(){objectReads++;return function(){objectCalls++;objectReceiver&&=this===object}}}
  target.addEventListener('click',object);target.dispatchEvent(new Event('click'));target.dispatchEvent(new Event('click'))
  target.removeEventListener('click',object);target.dispatchEvent(new Event('click'))
  const controller=new AbortController();let once=0,aborted=0
  target.addEventListener('click',()=>once++,{once:true,signal:controller.signal})
  target.dispatchEvent(new Event('click'));target.dispatchEvent(new Event('click'));controller.abort()
  target.addEventListener('click',()=>aborted++,{signal:controller.signal});target.dispatchEvent(new Event('click'))
  const error=Error('original listener error');let originalError=false
  const onError=event=>{originalError=event.error===error;event.preventDefault()}
  addEventListener('error',onError)
  target.addEventListener('click',()=>{throw error},{once:true});target.dispatchEvent(new Event('click'))
  removeEventListener('error',onError)
  let afterStop=0
  const stopped=()=>afterStop++
  target.addEventListener('click',stopped)
  globalThis.__nativePreviewClickListenerObservation?.stop()
  target.removeEventListener('click',stopped);target.dispatchEvent(new Event('click'))
  target.addEventListener('click',stopped);target.addEventListener('click',stopped);target.dispatchEvent(new Event('click'))
  return {calls,typeReads,optionReads,receiver,objectCalls,objectReads,objectReceiver,once,aborted,originalError,afterStop}
}

test('listener observation preserves native browser ownership and distinguishes delayed installation',{
  skip:process.env.NATIVE_PREVIEW_CLICK_LISTENER_CONTROL!=='1'?'Opt-in desktop click-listener control':false,
  timeout:60000,
},async()=>{
  const require=createRequire(join(resolve(process.env.NATIVE_PREVIEW_CLICK_LISTENER_PLAYWRIGHT_ROOT??process.cwd()),'package.json'))
  assert.equal(require('@playwright/test/package.json').version,'1.63.0')
  const {chromium,firefox,webkit}=require('@playwright/test')
  let release
  const server=createServer((request,response)=>{
    if(request.url==='/gate'){release=()=>{response.writeHead(200);response.end('ready')};return}
    response.writeHead(200,{'Content-Type':'text/html'})
    if(request.url==='/reference'){response.end('<!doctype html><title>Native listener reference</title>');return}
    response.end(`<!doctype html><button>Count</button><output>0</output><script type="module">
      await fetch('/gate');
      document.querySelector('button').addEventListener('click',()=>{
        const output=document.querySelector('output');output.textContent=String(Number(output.textContent)+1)
      });globalThis.handlerInstalled=true;
    </script>`)
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  try{for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const reference=await browser.newPage()
      await reference.goto(origin+'/reference')
      const expected=await reference.evaluate(nativeCases)
      const {originalError,...ownership}=expected
      assert.equal(typeof originalError,'boolean')
      assert.deepEqual(ownership,{calls:1,typeReads:2,optionReads:3,receiver:[true],
        objectCalls:2,objectReads:2,objectReceiver:true,once:1,aborted:0,afterStop:1})
      await reference.close()
      const page=await browser.newPage()
      await page.addInitScript(installNativePreviewClickListenerObservation,{previewOrigin:origin})
      release=undefined
      await page.goto(origin,{waitUntil:'commit'});await page.waitForSelector('button')
      const before=await page.evaluate(()=>{
        document.querySelector('button').click()
        return {count:document.querySelector('output').textContent,snapshot:__nativePreviewClickListenerObservation.snapshot()}
      })
      assert.equal(before.count,'0')
      assert.equal(before.snapshot.rows.filter(row=>row.kind==='listener-add'&&row.tag==='button').length,0)
      if(!release)await new Promise(resolve=>{
        const onRequest=request=>{if(request.url==='/gate'){server.off('request',onRequest);resolve()}}
        server.on('request',onRequest)
        if(release){server.off('request',onRequest);resolve()}
      })
      release();await page.waitForFunction(()=>globalThis.handlerInstalled===true)
      const after=await page.evaluate(()=>{
        document.querySelector('button').click()
        return {count:document.querySelector('output').textContent,snapshot:__nativePreviewClickListenerObservation.snapshot()}
      })
      assert.equal(after.count,'1')
      assert.deepEqual(after.snapshot.rows.filter(row=>row.tag==='button').map(row=>row.kind),['listener-add'])
      assert.equal(after.snapshot.dropped,0)
      assert.deepEqual(await page.evaluate(nativeCases),expected)
      console.log(JSON.stringify({browser:engine.name(),version:browser.version(),earlyCount:before.count,
        installedCount:after.count,nativeErrorIdentityReported:originalError,nativeOwnershipPreserved:true,passed:true}))
    }finally{await browser.close()}
  }}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
