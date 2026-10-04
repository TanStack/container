import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {resolve,sep} from 'node:path'
import {chromium,firefox,webkit} from '@playwright/test'
const sdk=process.env.NATIVE_SDK_BUNDLE_DIR
const runtimePath=process.env.NATIVE_TEST_NESTED_RUNTIME==='1'?'/sdk/runtime/':'/runtime/'
const rolldownVersion=process.env.NATIVE_TEST_ROLLDOWN_VERSION??'1.2.11'
if(!/^\d+\.\d+\.\d+$/.test(rolldownVersion))throw Error('Expected exact test Rolldown version')
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(`http://127.0.0.1:${server.address().port}`)))
const close=server=>new Promise((done,fail)=>server.close(error=>error?fail(error):done()))
test('lockless preparation runs through a separate-origin owner',{skip:!sdk},async()=>{
  let hostOrigin,ownerOrigin
  const handler=owner=>async(request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    response.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    const path=new URL(request.url,'http://localhost').pathname
    if(path.startsWith('/sdk/')||(runtimePath==='/runtime/'&&path.startsWith('/runtime/'))){
      const root=resolve(sdk),file=resolve(root,path.startsWith('/sdk/')?path.slice(5):path.slice(1))
      if(!file.startsWith(root+sep)){response.writeHead(404);response.end();return}
      try{
        response.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':/\.m?js$/.test(file)?'text/javascript':'application/octet-stream')
        response.end(await readFile(file))
      }catch{response.writeHead(404);response.end()}
      return
    }
    response.setHeader('Content-Type','text/html')
    response.end(owner?`<script type="module">
      import {installNativeOwnerHost} from '/sdk/index.js';
      installNativeOwnerHost({allowedParentOrigin:${JSON.stringify(hostOrigin)},assetBaseURL:${JSON.stringify(runtimePath)},workerURL:${JSON.stringify(runtimePath+'native/engine.js')},runtimeCandidates:[{workerURL:${JSON.stringify(runtimePath+'native/engine.js')},toolchain:{vite:'8.3.1',rolldown:${JSON.stringify(rolldownVersion)}}}]});
      parent.postMessage('ready',${JSON.stringify(hostOrigin)});
    </script>`:`<script>window.ready=new Promise(done=>addEventListener('message',event=>{if(event.origin===${JSON.stringify(ownerOrigin)}&&event.data==='ready')done()}))</script><iframe id="owner" allow="cross-origin-isolated" src="${ownerOrigin}/"></iframe>`)
  }
  const host=createServer(handler(false)),owner=createServer(handler(true))
  try{
    hostOrigin=await listen(host);ownerOrigin=await listen(owner)
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch({headless:true})
      try{
        const page=await browser.newPage()
        page.on('pageerror',error=>console.log(engine.name(),'page error',error.message))
        page.on('requestfailed',request=>console.log(engine.name(),'request failed',request.url(),request.failure()))
        await page.goto(hostOrigin);await page.evaluate(()=>window.ready)
        const result=await page.evaluate(async({ownerOrigin,rolldownVersion})=>{
          const {NativeOwnerClient}=await import('/sdk/index.js')
          const client=await NativeOwnerClient.connect(document.querySelector('#owner').contentWindow,ownerOrigin)
          try{
            const files={
              '/project/package.json':JSON.stringify({type:'module',scripts:{build:'vite build'},dependencies:{vite:'8.3.1',rolldown:rolldownVersion,lightningcss:'1.33.0','is-number':'7.0.0'}}),
              '/project/server.js':'import isNumber from "is-number";export default {fetch(){return new Response(isNumber(42)?"owner prepared":"wrong")}}',
              '/project/index.html':'<script type="module" src="/main.js"></script>',
              '/project/main.js':'import isNumber from "is-number";document.body.textContent=String(isNumber(42));',
            }
            const options={workspaceRoot:'/project',entry:'server.js',serveFetchEntry:true,staticRoot:'/project/dist'}
            const starting=client.start(files,options)
            let pendingRejected=false,runningRejected=false
            try{await client.start(files,options)}catch(error){pendingRejected=String(error).includes('running or starting project')}
            const port=await starting
            try{await client.start(files,options)}catch(error){runningRejected=String(error).includes('running or starting project')}
            const response=await client.fetch(new Request('http://localhost:'+port+'/'))
            const lock=JSON.parse(new TextDecoder().decode(await client.readFile('/project/package-lock.json')))
            const body=await response.text()
            const build=await client.terminalCommand('npm run build','/project')
            if(build.exitCode!==0)throw Error('Declared compiler build failed: '+JSON.stringify(build))
            const html=new TextDecoder().decode(await client.readFile('/project/dist/index.html'))
            const built=html.includes('/assets/')&&build.stdout.includes('vite build')
            const preview=await client.fetch(new Request('http://localhost:'+port+'/'))
            const previewHTML=await preview.text()
            if(preview.status!==200||previewHTML!==html)throw Error('Build HTML was not served by the preview')
            const documentHTML=new DOMParser().parseFromString(previewHTML,'text/html')
            const script=documentHTML.querySelector('script[type="module"][src]')
            if(!script)throw Error('Build HTML has no module entry')
            const asset=await client.fetch(new Request(new URL(script.getAttribute('src'),'http://localhost:'+port+'/')))
            if(asset.status!==200)throw Error('Build module was not served by the preview')
            const moduleURL=URL.createObjectURL(new Blob([await asset.text()],{type:'text/javascript'}))
            const frame=document.createElement('iframe')
            let rendered=false
            try{
              const loaded=new Promise(done=>frame.addEventListener('load',done,{once:true}))
              frame.srcdoc='<script type="module" src="'+moduleURL+'"></script>'
              document.body.append(frame)
              await loaded
              rendered=frame.contentDocument.body.textContent==='true'
            }finally{frame.remove();URL.revokeObjectURL(moduleURL)}
            const session=await client.openTerminalSession('/project')
            let sessionWorked=false
            try{
              const command=session.runCommand("node -e 'console.log(40+2)'")
              const result=await command.result
              sessionWorked=result.exitCode===0&&result.stdout.trim()==='42'
            }finally{await session.dispose()}
            await client.dispose()
            const nextPort=await client.start(files,options)
            const next=await client.fetch(new Request('http://localhost:'+nextPort+'/'))
            return {status:response.status,body,vite:lock.packages['node_modules/vite'].version,rolldown:lock.packages['node_modules/rolldown'].version,built,rendered,sessionWorked,pendingRejected,runningRejected,restarted:next.status===200&&await next.text()==='owner prepared'}
          }finally{await client.dispose()}
        },{ownerOrigin,rolldownVersion})
        assert.deepEqual(result,{status:200,body:'owner prepared',vite:'8.3.1',rolldown:rolldownVersion,built:true,rendered:true,sessionWorked:true,pendingRejected:true,runningRejected:true,restarted:true},engine.name())
        console.log(engine.name(),'owner preparation passed')
      }finally{await browser.close()}
    }
  }finally{await Promise.all([close(host),close(owner)])}
})
