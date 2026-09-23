import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'

const root=realpathSync(process.env.SDK_OUTPUT)
const manifestBytes=readFileSync(resolve(root,'manifest.json'))
const manifest=JSON.parse(manifestBytes)
let host,url,engine
test.beforeAll(async()=>{
  const {resolveSDKRuntimeProfile}=await import(pathToFileURL(resolve(root,'index.js')).href)
  engine=resolveSDKRuntimeProfile(manifest,'vite')
  host=createServer((request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    response.setHeader('Cache-Control','no-store')
    const path=new URL(request.url,'http://localhost').pathname
    if(path==='/'){response.setHeader('Content-Type','text/html');response.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('Outside SDK')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('Outside SDK')
      response.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      response.end(readFileSync(file))
    }catch{response.statusCode=404;response.end()}
  })
  await new Promise((done,reject)=>{host.once('error',reject);host.listen(0,'127.0.0.1',done)})
  url=`http://127.0.0.1:${host.address().port}`
})
test.afterAll(async()=>{if(host)await new Promise(done=>host.close(done))})

test('packaged SDK discovers silent ephemeral HTTP listeners and their closure',async({page},info)=>{
  test.setTimeout(60000)
  const errors=[];page.on('pageerror',error=>errors.push(String(error)))
  let result,failure
  try{
    await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
    result=await page.evaluate(async options=>{
      const {WorkerKernel,WorkerHTTP}=window.sdk
      // No stdout marker or configured port, readiness must cross the worker channel.
      const source="const http=require('node:http');http.createServer((request,response)=>{response.setHeader('content-type','text/plain');response.end('discovered '+request.url)}).listen(0,'127.0.0.1')"
      const kernel=new WorkerKernel({'/server.cjs':source},{...options,maxBytes:64*1024*1024,timeoutMs:10000})
      const events=[],unsubscribed=[],runs=[]
      const unsubscribe=kernel.subscribePorts(event=>unsubscribed.push({...event}))
      kernel.subscribePorts(event=>events.push({...event}))
      const waitFor=(type,port)=>{
        let off,timer,settled=false
        const promise=new Promise((resolve,reject)=>{
          timer=setTimeout(()=>{settled=true;off?.();reject(Error('Timed out waiting for '+type))},15000)
          off=kernel.subscribePorts(event=>{
            if(event.type!==type||(port!==undefined&&event.port!==port))return
            settled=true;clearTimeout(timer);off?.();resolve(event.port)
          })
          if(settled)off()
        })
        void promise.catch(()=>{})
        return {promise,cancel(){clearTimeout(timer);off?.()}}
      }
      let child,drain
      try{
        for(let index=0;index<2;index++){
          const opened=waitFor('open')
          let port,stdout='',stderr=''
          try{
            child=await kernel.spawn('node',['/server.cjs'],{lifetime:'session',timeoutMs:10000,maxBytes:64*1024*1024})
            const process=child
            drain=(async()=>{for(;;){const event=await process.next();if(!event||event.type==='exit')break;if(event.type==='stdout')stdout+=new TextDecoder().decode(event.bytes);if(event.type==='stderr')stderr+=new TextDecoder().decode(event.bytes)}})()
            port=await Promise.race([opened.promise,drain.then(()=>{throw Error('Server exited before listening: '+stderr)})])
          }finally{opened.cancel()}
          const replay=[];const stopReplay=kernel.subscribePorts(event=>replay.push({...event}))
          stopReplay()
          const snapshot=kernel.listeningPorts;snapshot.push(1)
          const active=kernel.listeningPorts
          const response=await new WorkerHTTP(kernel,port).fetch(new Request('http://localhost/probe?run='+index))
          const body=await response.text()
          if(index===0)unsubscribe()
          const closed=waitFor('close',port)
          try{await child.dispose();child=undefined;await closed.promise;await drain;drain=undefined}finally{closed.cancel()}
          const afterClose=[];const stopAfterClose=kernel.subscribePorts(event=>afterClose.push({...event}));stopAfterClose()
          runs.push({port,status:response.status,body,stdout,stderr,replay,active,afterClose,remaining:kernel.listeningPorts})
        }
        return {runs,events,unsubscribed}
      }finally{
        unsubscribe()
        if(child)await child.dispose()
        if(drain)await drain
        kernel.close();await kernel.shutdown
      }
    },engine.kernelOptions)
    expect(result.runs).toHaveLength(2)
    for(const [index,run] of result.runs.entries()){
      expect(run.port).toBeGreaterThanOrEqual(49152)
      expect(run.port).toBeLessThanOrEqual(65535)
      expect(run.status).toBe(200)
      expect(run.body).toBe('discovered /probe?run='+index)
      expect(run.stdout).toBe('');expect(run.stderr).toBe('')
      expect(run.replay).toEqual([{type:'open',port:run.port}])
      expect(run.active).toEqual([run.port])
      expect(run.afterClose).toEqual([]);expect(run.remaining).toEqual([])
    }
    expect(result.events).toEqual(result.runs.flatMap(({port})=>[{type:'open',port},{type:'close',port}]))
    expect(result.unsubscribed).toEqual([{type:'open',port:result.runs[0].port}])
    expect(errors).toEqual([])
  }catch(error){failure=String(error);throw error}
  finally{
    const path=info.outputPath('port-discovery.json')
    await writeFile(path,JSON.stringify({sdk:root,manifest,manifestSHA256:createHash('sha256').update(manifestBytes).digest('hex'),engine,browser:info.project.name,browserVersion:page.context().browser()?.version(),actualSafari:false,result,errors,failure},null,2))
    await info.attach('port-discovery.json',{path,contentType:'application/json'})
  }
})
