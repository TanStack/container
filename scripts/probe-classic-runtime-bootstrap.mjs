import {readFile,readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {chromium,firefox,webkit} from 'playwright'

const bootstrap=await readFile(new URL('../src/native/classic-worker-bootstrap.js',import.meta.url),'utf8')
const runtime=process.env.NATIVE_VITE8_BUNDLE_DIR
if(!runtime)throw Error('Set NATIVE_VITE8_BUNDLE_DIR to the runtime being tested')
const assets=new Map()
for(const entry of await readdir(runtime,{withFileTypes:true}))
  if(entry.isFile())assets.set(entry.name,await readFile(join(runtime,entry.name)))
const server=createServer((request,response)=>{
  response.setHeader('Cross-Origin-Opener-Policy','same-origin')
  response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
  response.setHeader('Content-Type',request.url==='/'?'text/html':'text/javascript')
  if(request.url==='/')response.end('<!doctype html>')
  else if(request.url.startsWith('/renamed/selected-runtime.js'))response.end(`postMessage({type:'native-dev-ready',entry:import.meta.url})`)
  else if(request.url.startsWith('/fixture/engine.js'))response.end(`await new Promise(resolve=>setTimeout(resolve,20));self.onmessage=event=>{if(event.ports[0])event.ports[0].postMessage('port retained');postMessage({value:event.data,classic:typeof importScripts==='function',ports:event.ports.length})};`)
  else if(request.url.startsWith('/broken/engine.js'))response.end(`throw new Error('expected bootstrap failure')`)
  else if(request.url.startsWith('/real/')&&assets.has(new URL(request.url,'http://local.test').pathname.slice(6)))
    response.end(assets.get(new URL(request.url,'http://local.test').pathname.slice(6)))
  else if(request.url.includes('/classic-worker-bootstrap.js'))response.end(bootstrap)
  else{response.statusCode=404;response.end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
try{
  for(const browserType of [chromium,firefox,webkit]){
    const browser=await browserType.launch()
    try{
      const page=await browser.newPage()
      await page.goto(`http://127.0.0.1:${server.address().port}`)
      const results=await page.evaluate(async()=>{
        const results=[]
        for(const mode of ['fixture','real','broken','renamed']){
          const suffix=mode==='renamed'?'?native-engine-path=%2Frenamed%2Fselected-runtime.js&probe=preserved':''
          const worker=new Worker(`/${mode}/classic-worker-bootstrap.js${suffix}`)
          const channel=new MessageChannel()
          let portValue
          channel.port1.onmessage=event=>{portValue=event.data}
          try{
            const messages=await new Promise((resolve,reject)=>{
              const received=[]
              const timer=setTimeout(()=>reject(Error('Bootstrap timed out: '+mode)),30000)
              worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message))}
              worker.onmessage=event=>{
                if(event.data.type==='native-dev-fatal'){
                  clearTimeout(timer)
                  if(mode==='broken'){resolve([event.data]);return}
                  reject(Error(event.data.error));return
                }
                received.push(event.data)
                if(mode==='fixture'?received.length===4:event.data.type==='native-dev-ready'){
                  clearTimeout(timer);resolve(received)
                }
              }
              if(mode==='fixture'){
                for(const value of [1,2,3])worker.postMessage(value)
                worker.postMessage(4,[channel.port2])
              }
            })
            if(mode==='fixture'&&portValue!== 'port retained'){
              await new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(Error('Transferred port was lost')),1000)
                channel.port1.onmessage=event=>{portValue=event.data;clearTimeout(timer);resolve()}
              })
            }
            results.push({mode,messages,portValue})
          }finally{worker.terminate();channel.port1.close();channel.port2.close()}
        }
        return results
      })
      const values=results[0].messages.map(message=>message.value)
      if(JSON.stringify(values)!=='[1,2,3,4]'||!results[0].messages.every(message=>message.classic)||results[0].portValue!=='port retained')
        throw Error('Queued startup messages changed: '+JSON.stringify(results))
      if(!results[2].messages[0].error.includes('expected bootstrap failure'))throw Error('Startup error lost')
      const selected=new URL(results[3].messages[0].entry)
      if(selected.pathname!=='/renamed/selected-runtime.js'||selected.searchParams.get('probe')!=='preserved'||selected.searchParams.has('native-engine-path'))
        throw Error('Selected engine URL changed: '+selected.href)
      console.log(JSON.stringify({browser:browserType.name(),results}))
    }finally{await browser.close()}
  }
}finally{await new Promise(resolve=>server.close(resolve))}
