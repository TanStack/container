import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {chromium,firefox,webkit} from '@playwright/test'
import {sdkBrowserAssets} from '../scripts/sdk-browser-assets.mjs'
import {installFetchConsumptionObservation} from '../scripts/native-fetch-consumption-observation.mjs'

test('installed preview transport completes sequential mutations and streams without Vite or a framework',{
  skip:process.env.NATIVE_PREVIEW_RPC_CONTROL!=='1'?'Opt-in installed preview transport control':false,
  timeout:60000,
},async()=>{
  const sdk=process.env.NATIVE_SDK_BUNDLE_DIR,deployment=process.env.NATIVE_DEPLOYMENT_DIR
  assert.ok(sdk&&deployment,'Pass the installed SDK and prepared deployment')
  const source=resolve(process.env.NATIVE_SOURCE_ROOT??process.cwd())
  const {nativeReleaseAcceptanceIdentity}=await import(pathToFileURL(join(source,'scripts/native-release-acceptance.mjs')).href)
  const before=nativeReleaseAcceptanceIdentity(source,sdk,deployment),assets=sdkBrowserAssets(sdk)
  const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
    'Cross-Origin-Resource-Policy':'cross-origin','Cache-Control':'no-store'}
  const app=createServer(async(request,response)=>{
    const file=assets.get(new URL(request.url,'http://localhost').pathname)
    response.writeHead(200,{...headers,'Content-Type':file?'text/javascript':'text/html'})
    response.end(file?await readFile(file):'<!doctype html><title>Preview RPC transport control</title><div id="target"></div>')
  })
  const preview=createServer(async(request,response)=>{
    const name=new URL(request.url,'http://localhost').pathname.slice('/__sandbox/'.length)
    if(!request.url.startsWith('/__sandbox/')||!['bridge.html','bridge.js','sw.js','inspect.js','websocket.js','request-policy.js'].includes(name)){
      response.writeHead(404);response.end();return
    }
    response.writeHead(200,{...headers,'Service-Worker-Allowed':'/','Content-Type':name.endsWith('.html')?'text/html':'text/javascript'})
    response.end(await readFile(join(deployment,'preview-host/__sandbox',name)))
  })
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)))
  const appOrigin=await listen(app),previewOrigin=await listen(preview)
  try{
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch()
      try{
        const page=await browser.newPage()
        const consumption=[]
        page.on('console',message=>{if(message.text().startsWith('NATIVE_FETCH_CONSUMPTION '))
          consumption.push(JSON.parse(message.text().slice('NATIVE_FETCH_CONSUMPTION '.length)))})
        await page.addInitScript(installFetchConsumptionObservation,{previewOrigin,pathPrefix:'/rpc/'})
        await page.goto(appOrigin)
        const result=await page.evaluate(async({previewOrigin})=>{
          const {URLPreview}=await import('/sdk/index.js')
          let count=0
          const received=[]
          const server={fetch:async request=>{
            const path=new URL(request.url).pathname
            received.push({path,method:request.method})
            if(path==='/')return new Response('<!doctype html><button id="mutate">Count: 0</button><button id="stream">Stream</button><pre id="result"></pre><script src="/app.js"></script>',{headers:{'Content-Type':'text/html'}})
            if(path==='/app.js')return new Response(`
              document.querySelector('#mutate').onclick=async()=>{
                await(await fetch('/rpc/count',{method:'POST'})).json();
                const value=await(await fetch('/rpc/count')).json();
                document.querySelector('#mutate').textContent='Count: '+value;
              };
              document.querySelector('#stream').onclick=async()=>{
                const reader=(await fetch('/rpc/stream')).body.getReader(),decoder=new TextDecoder();
                const target=document.querySelector('#result');target.textContent='';
                try{for(;;){const next=await reader.read();if(next.done)break;target.textContent+=decoder.decode(next.value)}}
                finally{reader.releaseLock()}
                target.textContent+='Done';
              };
            `,{headers:{'Content-Type':'text/javascript'}})
            if(path==='/rpc/count'){
              if(request.method==='POST')count++
              return Response.json(count)
            }
            if(path==='/rpc/stream'){
              let timer,index=0
              return new Response(new ReadableStream({
                start(controller){timer=setInterval(()=>{controller.enqueue(new TextEncoder().encode('Number '+(++index)+'\n'));if(index===10){clearInterval(timer);controller.close()}},50)},
                cancel(){clearInterval(timer)},
              }),{headers:{'Content-Type':'text/plain'}})
            }
            return new Response('Not found',{status:404})
          }}
          const preview=await URLPreview.mount(document.querySelector('#target'),{origin:previewOrigin,server})
          const wait=async(predicate,label)=>{
            const deadline=performance.now()+5000
            while(performance.now()<deadline){if(predicate((await preview.inspect()).text))return;await new Promise(resolve=>setTimeout(resolve,20))}
            throw Error(label)
          }
          try{
            await wait(text=>text.includes('Count: 0'),'Initial document missing')
            for(let round=1;round<=3;round++){
              await preview.click('#mutate');await wait(text=>text.includes('Count: '+round),'Mutation did not complete')
              for(let stream=0;stream<2;stream++){
                await preview.click('#stream')
                await wait(text=>text.includes('Number 1\n')&&!text.includes('Done'),'No partial stream')
                await wait(text=>text.includes('Number 10\nDone'),'No stream EOF')
              }
            }
            return {count,received,requests:preview.requests,diagnostics:preview.diagnostics}
          }catch(error){
            console.info('NATIVE_PREVIEW_RPC_CONTROL_FAILURE '+JSON.stringify({error:String(error),received,requests:preview.requests,diagnostics:preview.diagnostics}))
            throw error
          }finally{preview.close()}
        },{previewOrigin})
        assert.equal(result.count,3)
        assert.deepEqual(result.diagnostics,[])
        assert.equal(result.received.filter(row=>row.path.startsWith('/rpc/')).length,12)
        assert.equal(consumption.filter(row=>row.kind==='fetch-fulfilled').length,12)
        assert.equal(consumption.filter(row=>row.kind==='read-fulfilled'&&row.done).length,6)
        assert.ok(!consumption.some(row=>row.kind==='limit'))
        assert.deepEqual(nativeReleaseAcceptanceIdentity(source,sdk,deployment),before)
        console.log(JSON.stringify({browser:engine.name(),version:browser.version(),previewRPCControl:'passed',mutations:3,streams:6}))
      }finally{await browser.close()}
    }
  }finally{await Promise.all([app,preview].map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))))}
})
