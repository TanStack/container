import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {join,resolve,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import {chromium,firefox,webkit} from '@playwright/test'

const sdkRoot=process.env.NATIVE_SDK_BUNDLE_DIR
const deployment=process.env.NATIVE_DEPLOYMENT_DIR
test('installed owner orders terminal reinstall and cancels HTTP across its real transport',{
  skip:!sdkRoot||!deployment?'Set NATIVE_SDK_BUNDLE_DIR and NATIVE_DEPLOYMENT_DIR to an installed consumer':false,
  timeout:180000,
},async()=>{
  const assetsAPI=await import(pathToFileURL(join(sdkRoot,'assets.mjs')).href)
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)))
  const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
  const serveSDK=async response=>{
    response.setHeader('Content-Type','text/javascript')
    response.end(await readFile(join(sdkRoot,'index.js')))
  }
  let assets
  const parent=createServer(async(request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    if(request.url==='/sdk/index.js')return serveSDK(response)
    response.setHeader('Content-Type','text/html')
    response.end('<!doctype html><iframe id="owner" allow="cross-origin-isolated"></iframe>')
  })
  const owner=createServer(async(request,response)=>{
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    response.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    response.setHeader('X-Content-Type-Options','nosniff')
    if(request.url==='/sdk/index.js')return serveSDK(response)
    const pathname=new URL(request.url,'http://localhost').pathname
    if(assets.files[pathname]!==undefined){
      for(const [name,value] of Object.entries(assets.headers[pathname]))response.setHeader(name,value)
      response.end(assets.files[pathname]);return
    }
    const root=resolve(deployment,'runtime'),file=resolve(deployment,'.'+pathname)
    if(!pathname.startsWith('/runtime/')||!file.startsWith(root+sep)){
      response.writeHead(404);response.end();return
    }
    try{
      response.setHeader('Content-Type',pathname.endsWith('.wasm')?'application/wasm':'text/javascript')
      response.end(await readFile(file))
    }catch{response.writeHead(404);response.end()}
  })
  const preview=createServer((_request,response)=>{response.writeHead(503);response.end()})
  try{
    const parentOrigin=await listen(parent),ownerOrigin=await listen(owner),previewOrigin=await listen(preview)
    // This empty-dependency project tests transport ordering with one advertised runtime.
    // Automatic compiler selection is covered by the pinned framework example gates.
    assets=assetsAPI.createNativeOwnerHostAssets({parentOrigin,previewOrigin,buildId:'terminal-install-order',
      workerPath:assetsAPI.readNativeRuntimeCandidates()[0].workerURL})
    const engines=process.env.NATIVE_OWNER_BROWSER?[{chromium,firefox,webkit}[process.env.NATIVE_OWNER_BROWSER]]:[chromium,firefox,webkit]
    assert.ok(engines.every(Boolean),'Unknown browser selection')
    for(const engine of engines){
      const browser=await engine.launch({headless:true})
      try{
        const page=await browser.newPage()
        await page.goto(parentOrigin)
        const result=await page.evaluate(async({ownerOrigin})=>{
          const {NativeOwnerClient}=await import('/sdk/index.js')
          const frame=document.querySelector('#owner')
          await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{removeEventListener('message',ready);reject(Error('Owner did not become ready'))},10000)
            const ready=event=>{
              if(event.origin!==ownerOrigin||event.data!=='native-owner-ready')return
              clearTimeout(timer);removeEventListener('message',ready);resolve()
            }
            addEventListener('message',ready);frame.src=ownerOrigin+'/owner.html'
          })
          const client=await NativeOwnerClient.connect(frame.contentWindow,ownerOrigin,undefined,{expectedBuildId:'terminal-install-order'})
          let command
          try{
            await client.start({
              '/app/package.json':'{"name":"terminal-order","version":"1.0.0","type":"module"}',
              '/app/package-lock.json':'{"name":"terminal-order","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"terminal-order","version":"1.0.0"}}}',
              '/app/index.html':'<!doctype html><script type="module" src="/main.js"></script>',
              '/app/main.js':'document.body.textContent="terminal order"',
              '/app/hold.cjs':'process.stdin.resume();process.stdin.on("end",()=>{require("node:fs").writeFileSync("retained.txt","written before install");console.log("written")});console.log("ready");',
            })
            const session=await client.openTerminalSession('/app')
            let output=''
            command=session.runCommand('node hold.cjs',text=>{output+=text})
            const until=async(predicate,label)=>{
              for(let attempt=0;attempt<200;attempt++){
                if(await predicate())return
                await new Promise(resolve=>setTimeout(resolve,25))
              }
              throw Error(label)
            }
            await until(()=>output.includes('ready'),'Terminal did not reach stdin wait')
            let installCompleted=false,openingCompleted=false
            const installing=client.reinstall().then(value=>{installCompleted=true;return value})
            // Attach rejection handlers immediately, failed assertions still tear down the owner.
            installing.catch(()=>{})
            await until(async()=> (await client.resources()).installing,'Install was not queued')
            const during=await client.resources()
            if(during.commands!==1||during.mutations!==1||installCompleted)
              throw Error('Reinstall did not wait for the terminal command: '+JSON.stringify(during))
            const opening=client.openTerminalSession('/app').then(value=>{openingCompleted=true;return value})
            opening.catch(()=>{})
            // This round trip ensures the preceding session-open request reached the owner.
            await client.resources()
            if(openingCompleted)throw Error('Terminal opened on the retiring worker')
            command.endInput()
            const completed=await command.result
            if(completed.exitCode!==0||!output.includes('written'))throw Error('Held terminal write did not complete')
            const port=await installing
            const replacementSession=await opening
            try{
              const probe=await replacementSession.runCommand('printf replacement-session').result
              if(probe.exitCode!==0||probe.stdout!=='replacement-session')throw Error('Replacement terminal is not usable')
              const retained=new TextDecoder().decode(await client.readFile('/app/retained.txt'))
              const html=await(await client.fetch(new Request('http://127.0.0.1:'+port+'/'))).text()
              await client.writeFile('/app/http-hold.cjs',[
                'const http=require("node:http");let held=0,closed=0;',
                'http.createServer((req,res)=>{',
                'if(req.url==="/hold"){held++;console.log("held");res.on("close",()=>{closed++;console.log("closed")});return}',
                'if(req.url==="/body"){res.write("first");setTimeout(()=>res.end("last"),10000);return}',
                'res.end(JSON.stringify({held,closed}));',
                '}).listen(3001,()=>console.log("http ready"));',
              ].join(''))
              let httpOutput=''
              const httpCommand=replacementSession.runCommand('node http-hold.cjs',text=>{httpOutput+=text})
              try{
                await until(()=>httpOutput.includes('http ready'),'HTTP fixture did not listen')
                const controllers=Array.from({length:32},()=>new AbortController())
                const pending=controllers.map(controller=>client.fetch(new Request('http://127.0.0.1:3001/hold',{signal:controller.signal})).catch(error=>error))
                await until(()=>httpOutput.split('held').length===33,'The old requests did not fill the HTTP pool')
                const reason=Error('Replacement document')
                controllers.forEach(controller=>controller.abort(reason))
                const errors=await Promise.all(pending)
                if(errors.some(error=>error!==reason))throw Error('HTTP cancellation lost the caller reason')
                await until(()=>httpOutput.split('closed').length===33,'Cancelled guest sockets did not close')
                const probe=await(await client.fetch(new Request('http://127.0.0.1:3001/ping'))).json()
                if(probe.held!==32||probe.closed!==32)throw Error('HTTP pool did not recover: '+JSON.stringify(probe))
                const controller=new AbortController()
                const response=await client.fetch(new Request('http://127.0.0.1:3001/body',{signal:controller.signal}))
                const reader=response.body.getReader()
                const first=await reader.read()
                if(new TextDecoder().decode(first.value)!=='first')throw Error('Body did not stream its first chunk')
                const reading=reader.read().catch(error=>error)
                controller.abort(reason)
                if(await reading!==reason)throw Error('Pending body read did not preserve cancellation')
                await until(async()=> (await client.resources()).responseStreams===0,'Cancelled body remained registered')
              }finally{httpCommand.interrupt();await httpCommand.result}
              const after=await client.resources()
              return {retained,html,during,after,isolated:crossOriginIsolated}
            }finally{await replacementSession.dispose()}
          }finally{command?.interrupt();await client.dispose();client.close()}
        },{ownerOrigin})
        assert.equal(result.isolated,true)
        assert.equal(result.retained,'written before install')
        assert.match(result.html,/main\.js/)
        assert.equal(result.during.installing,true)
        assert.equal(result.after.commands,0)
        assert.equal(result.after.mutations,0)
        assert.equal(result.after.installing,false)
        console.log(`${engine.name()}: terminal reinstall ordering, 32 cancelled HTTP slots, replacement fetch, and streaming body cancellation passed`)
      }finally{await browser.close()}
    }
  }finally{await Promise.all([close(parent),close(owner),close(preview)])}
})
