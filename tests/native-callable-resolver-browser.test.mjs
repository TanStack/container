import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {chromium,firefox,webkit} from '@playwright/test'
import {sdkBrowserAssets} from '../scripts/sdk-browser-assets.mjs'
import {probeCallableResolver} from './fixtures/native-callable-resolver.mjs'

test('the installed callable resolver matches Node for relative and private imports',{
  skip:process.env.NATIVE_CALLABLE_RESOLVER_CONTROL!=='1'?'Opt-in installed callable resolver control':false,
  timeout:180000,
},async()=>{
  const sdk=process.env.NATIVE_SDK_BUNDLE_DIR,deployment=process.env.NATIVE_DEPLOYMENT_DIR
  assert.ok(sdk&&deployment,'Pass the installed SDK and prepared deployment')
  const root=resolve(process.env.NATIVE_SOURCE_ROOT??process.cwd())
  const {nativeReleaseAcceptanceIdentity}=await import(pathToFileURL(join(root,'scripts/native-release-acceptance.mjs')).href)
  const before=nativeReleaseAcceptanceIdentity(root,sdk,deployment),assets=sdkBrowserAssets(sdk)
  const require=createRequire(import.meta.url)
  const rolldownManifest=await readFile(require.resolve('rolldown/package.json'),'utf8')
  assert.equal(JSON.parse(rolldownManifest).version,'1.2.11','Match the installed runtime resolver version')
  const rolldownEntry=await readFile(require.resolve('rolldown/experimental'),'utf8')
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
    response.end(file?await readFile(file):'<!doctype html><title>Callable resolver control</title>')
  })
  const owner=createServer(async(request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname,file=assets.get(path)??deployed.get(path)
    if(path==='/owner.html'){
      response.writeHead(200,{...headers,'Content-Type':'text/html'})
      response.end(`<!doctype html><script type="module">
        import {installNativeOwnerHost} from '/sdk/index.js';
        installNativeOwnerHost({allowedParentOrigin:${JSON.stringify(appOrigin)},workerURL:${JSON.stringify(workerPath)}});
        parent.postMessage('callable-owner-ready',${JSON.stringify(appOrigin)});
      </script>`)
    }else if(file){
      response.writeHead(200,{...headers,'Content-Type':path.endsWith('.wasm')?'application/wasm':'text/javascript'})
      response.end(await readFile(file))
    }else{response.writeHead(404);response.end()}
  })
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)))
  appOrigin=await listen(app)
  const ownerOrigin=await listen(owner)
  const source=`import {createServer} from 'node:http';
    import {writeFileSync,readFileSync} from 'node:fs';
    import {viteResolvePlugin} from 'rolldown/experimental';
    const probe=(${probeCallableResolver.toString()});
    const server=createServer(async(req,res)=>{
      res.setHeader('Connection','close');
      if(req.url!=='/run'){res.end('ok');return}
      try{const workspace={target:readFileSync('/app/fixture/target.js','utf8'),importer:readFileSync('/app/fixture/index.js','utf8')};
        const result=await probe(viteResolvePlugin,{root:'/app',readPackage:path=>readFileSync(path,'utf8'),
          report:state=>writeFileSync('/app/resolver-state.json',JSON.stringify(state))});
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({passed:result.failures.length===0,result,workspace}));}
      catch(error){res.statusCode=500;res.end(JSON.stringify({passed:false,error:String(error)}));}
    });server.listen(3000,'127.0.0.1');`
  const failures=[]
  try{
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch()
      try{
        const page=await browser.newPage()
        page.on('console',message=>{if(message.type()==='error')console.log(engine.name()+' '+message.text())})
        await page.goto(appOrigin)
        const result=await page.evaluate(async({ownerOrigin,source,rolldownManifest,rolldownEntry})=>{
          const {NativeOwnerClient}=await import('/sdk/index.js')
          const frame=document.createElement('iframe');frame.allow='cross-origin-isolated'
          const ready=new Promise((resolve,reject)=>{
            const timeout=setTimeout(()=>reject(Error('Owner did not load')),10000)
            const listener=event=>{
              if(event.source!==frame.contentWindow||event.origin!==ownerOrigin||event.data!=='callable-owner-ready')return
              clearTimeout(timeout);removeEventListener('message',listener);resolve()
            };addEventListener('message',listener)
          })
          frame.src=ownerOrigin+'/owner.html';document.body.append(frame);await ready
          const client=await NativeOwnerClient.connect(frame.contentWindow,ownerOrigin)
          const files={'/app/server.mjs':source,
            '/app/node_modules/rolldown/package.json':rolldownManifest,
            '/app/node_modules/rolldown/dist/experimental-index.mjs':rolldownEntry,
            '/app/fixture/package.json':JSON.stringify({type:'module',imports:{'#target':'./target.js'}}),
            '/app/fixture/index.js':'export {}','/app/fixture/target.js':'export const answer = 42'}
          let result
          try{
            const port=await client.start(files,{entry:'server.mjs',installDependencies:false,previewPort:3000})
            const response=await client.fetch(new Request('http://127.0.0.1:'+port+'/run'))
            const body=await response.json()
            const state=JSON.parse(new TextDecoder().decode(await client.readFile('/app/resolver-state.json')))
            result={status:response.status,body,state,resources:await client.resources(),
              diagnostics:client.events.filter(event=>event.type==='diagnostic')}
          }catch(error){result={error:String(error),events:client.events.slice(-8)}}
          finally{
            try{await client.dispose()}catch(error){result={...result,disposeError:String(error)}}
            client.close();frame.remove()
          }
          return result
        },{ownerOrigin,source,rolldownManifest,rolldownEntry})
        console.log(JSON.stringify({browser:engine.name(),version:browser.version(),result,
          passed:result.status===200&&result.body?.passed===true&&!result.disposeError}))
        try{
          assert.equal(result.status,200)
          assert.equal(result.body.passed,true)
          assert.equal(result.body.result.results.length,18)
          assert.equal(result.body.result.callbacks,9)
          assert.deepEqual(result.body.result.failures,[])
          assert.deepEqual(result.body.workspace,{target:'export const answer = 42',importer:'export {}'})
          assert.equal(result.disposeError,undefined)
          assert.deepEqual(result.diagnostics,[])
        }catch(error){failures.push({browser:engine.name(),error:String(error)})}
        assert.deepEqual(nativeReleaseAcceptanceIdentity(root,sdk,deployment),before,'Installed inputs changed')
      }finally{await browser.close()}
    }
  }finally{await Promise.all([app,owner].map(server=>new Promise(resolve=>server.close(resolve))))}
  assert.deepEqual(failures,[],'Callable resolver failed in one or more engines')
})
