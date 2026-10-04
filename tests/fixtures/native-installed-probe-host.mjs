import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium,firefox,webkit} from '@playwright/test'
import {sdkBrowserAssets} from '../../scripts/sdk-browser-assets.mjs'

export async function runInstalledNativeProbe({sdk,deployment,source,files,statePath}) {
  const assets=sdkBrowserAssets(sdk)
  const manifest=JSON.parse(await readFile(join(deployment,'deployment-manifest.json'),'utf8'))
  const deployed=new Map(manifest.files.map(file=>['/'+file.path,join(deployment,file.path)]))
  const workerPath=[...deployed.keys()].find(path=>path.startsWith('/runtime/native/vite-8.3.1-')&&path.endsWith('/engine.js'))
  assert.ok(workerPath,'Missing installed Vite 8.3.1 runtime')
  const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
    'Cross-Origin-Resource-Policy':'cross-origin','Cache-Control':'no-store'}
  let appOrigin
  const app=createServer(async(request,response)=>{
    const file=assets.get(new URL(request.url,'http://localhost').pathname)
    response.writeHead(200,{...headers,'Content-Type':file?'text/javascript':'text/html'})
    response.end(file?await readFile(file):'<!doctype html><title>Installed runtime control</title>')
  })
  const owner=createServer(async(request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname,file=assets.get(path)??deployed.get(path)
    if(path==='/owner.html'){
      response.writeHead(200,{...headers,'Content-Type':'text/html'})
      response.end(`<!doctype html><script type="module">
        import {installNativeOwnerHost} from '/sdk/index.js';
        installNativeOwnerHost({allowedParentOrigin:${JSON.stringify(appOrigin)},workerURL:${JSON.stringify(workerPath)}});
        parent.postMessage('probe-owner-ready',${JSON.stringify(appOrigin)});
      </script>`)
    }else if(file){
      response.writeHead(200,{...headers,'Content-Type':path.endsWith('.wasm')?'application/wasm':'text/javascript'})
      response.end(await readFile(file))
    }else{response.writeHead(404);response.end()}
  })
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)))
  const rows=[]
  try{
    appOrigin=await listen(app)
    const ownerOrigin=await listen(owner)
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch()
      try{
        const page=await browser.newPage()
        const result=await page.goto(appOrigin).then(()=>page.evaluate(async({ownerOrigin,source,files,statePath})=>{
          const {NativeOwnerClient}=await import('/sdk/index.js')
          const frame=document.createElement('iframe');frame.allow='cross-origin-isolated'
          const ready=new Promise((resolve,reject)=>{
            const timeout=setTimeout(()=>{removeEventListener('message',listener);reject(Error('Owner did not load'))},10000)
            const listener=event=>{
              if(event.source!==frame.contentWindow||event.origin!==ownerOrigin||event.data!=='probe-owner-ready')return
              clearTimeout(timeout);removeEventListener('message',listener);resolve()
            };addEventListener('message',listener)
          })
          frame.src=ownerOrigin+'/owner.html';document.body.append(frame);await ready
          const client=await NativeOwnerClient.connect(frame.contentWindow,ownerOrigin)
          let result
          try{
            const port=await client.start({...files,'/app/server.mjs':source},
              {entry:'server.mjs',installDependencies:false,previewPort:3000})
            const response=await client.fetch(new Request('http://127.0.0.1:'+port+'/run'))
            result={status:response.status,body:await response.json()}
          }catch(error){result={error:String(error),events:client.events.slice(-16)}}
          finally{
            try{result={...result,state:JSON.parse(new TextDecoder().decode(await client.readFile(statePath))),
              resources:await client.resources(),diagnostics:client.events.filter(event=>event.type==='diagnostic')}}
            catch(error){result={...result,stateError:String(error)}}
            try{await client.dispose()}catch(error){result={...result,disposeError:String(error)}}
            client.close();frame.remove()
          }
          return result
        },{ownerOrigin,source,files,statePath}))
        rows.push({browser:engine.name(),version:browser.version(),result})
      }catch(error){rows.push({browser:engine.name(),version:browser.version(),error:String(error)})}
      finally{await browser.close()}
    }
  }finally{await Promise.all([app,owner].filter(server=>server.listening).map(server=>new Promise(resolve=>server.close(resolve))))}
  return rows
}
