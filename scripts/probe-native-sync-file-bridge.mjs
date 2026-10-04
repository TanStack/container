import {chromium,firefox,webkit} from 'playwright'

const siteURL='http://127.0.0.1:4198/start/latest/docs/framework/react/examples/start-counter?panel=sandbox'
for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
  const browser=await engine.launch({headless:true})
  try{
    const page=await browser.newPage()
    const ownerFrame=page.waitForEvent('framenavigated',{
      predicate:frame=>frame.url().startsWith('http://127.0.0.1:4197/owner.html'),timeout:30000,
    })
    await page.goto(siteURL,{waitUntil:'domcontentloaded',timeout:120000})
    const frame=await ownerFrame
    const result=await frame.evaluate(async()=>{
      if(!crossOriginIsolated||typeof SharedArrayBuffer!=='function')
        return {supported:false,reason:'Owner frame is not cross-origin isolated'}
      const {NativeDevServer}=await import('/sdk/index.js')
      const server=new NativeDevServer({
        '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
        '/app/answer.txt':'before',
      },{workerURL:'/runtime/native/engine.js',entry:'/app/index.mjs',serveFetchEntry:true})
      await server.ready
      const source=`self.onmessage=({data})=>{
        const header=new Int32Array(data.header),bytes=new Uint8Array(data.bytes)
        self.postMessage({type:'read',path:'/app/answer.txt'})
        const wait=Atomics.wait(header,0,0,5000)
        if(wait==='timed-out'){self.postMessage({type:'result',error:'Timed out'});return}
        const length=Atomics.load(header,1)
        self.postMessage({type:'result',value:new TextDecoder().decode(bytes.slice(0,length))})
      }`
      const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
      const worker=new Worker(url)
      const header=new SharedArrayBuffer(8),bytes=new SharedArrayBuffer(65536)
      try{
        const response=new Promise((resolve,reject)=>{
          worker.onerror=event=>reject(Error(event.message))
          worker.onmessage=async({data})=>{
            if(data.type==='result'){resolve(data);return}
            try{
              const file=await server.readFile(data.path)
              if(file.byteLength>65536)throw Error('Response exceeds shared buffer')
              new Uint8Array(bytes).set(file)
              const view=new Int32Array(header)
              Atomics.store(view,1,file.byteLength)
              Atomics.store(view,0,1)
              Atomics.notify(view,0)
            }catch(error){reject(error)}
          }
        })
        worker.postMessage({header,bytes})
        return {supported:true,...await response}
      }finally{worker.terminate();URL.revokeObjectURL(url);await server.close()}
    })
    console.log(name,JSON.stringify(result))
    if(!result.supported||result.value!=='before')throw Error(`${name} sync file bridge failed`)
  }finally{await browser.close()}
}
