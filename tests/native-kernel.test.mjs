import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium,firefox} from '@playwright/test'
import {transform} from 'esbuild'

test('native worker owns files, serves requests, snapshots bytes, and cancels pending work',async()=>{
  const concurrentSource=(await transform(`
    const storage=new globalThis.__engineAsyncLocalStorage()
    export default {async fetch(request){
      const name=new URL(request.url).pathname.slice(1)
      return storage.run(name,async()=>{
        await new Promise(resolve=>setTimeout(resolve,name==='slow'?20:0))
        return new Response(String(storage.getStore()))
      })
    }}
  `,{target:'es2016',format:'esm'})).code
  const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'})
  await server.listen()
  try{
    const url=server.resolvedUrls.local[0]
    for(const browserType of [chromium,firefox]){
      const browser=await browserType.launch({headless:true})
      try{
        const page=await browser.newPage()
        await page.goto(url)
        const result=await page.evaluate(async({concurrentSource})=>{
          const {NativeKernel}=await import('/src/native/kernel.ts')
          const kernel=new NativeKernel()
          await kernel.load(`export default {async fetch(request){
            if(new URL(request.url).pathname==='/hang')return new Promise(()=>{})
            const bytes=globalThis.__webContainerHost.fsSync.readFile('/input.bin')
            return new Response(JSON.stringify({method:request.method,bytes:[...bytes]}))
          }}`,{'/input.bin':new Uint8Array([0,127,128,255])})
          const response=await kernel.request({url:'https://workspace.invalid/',method:'POST',body:'test'})
          await kernel.writeFile('/extra.bin',new Uint8Array([0,255]))
          const snapshot=await kernel.snapshot()
          const pending=kernel.request({url:'https://workspace.invalid/hang'}).then(()=>false,()=>true)
          kernel.close()
          const contextual=new NativeKernel()
          await contextual.load(concurrentSource,{}, {asyncContext:true})
          const [slow,fast]=await Promise.all(['slow','fast'].map(name=>contextual.request({url:'https://workspace.invalid/'+name})))
          contextual.close()
          const compiled=new NativeKernel()
          await compiled.initialize({'/app/server.ts':`const answer:number=42;export default {fetch(){return new Response(String(answer))}}`})
          await compiled.loadEntry('/app/server.ts')
          const compiledResponse=await compiled.request({url:'https://workspace.invalid/'})
          compiled.close()
          return {response,files:Object.fromEntries(Object.entries(snapshot).map(([path,bytes])=>[path,[...bytes]])),cancelled:await pending,contexts:[slow.body,fast.body],compiled:compiledResponse.body}
        },{concurrentSource})
        assert.equal(result.response.status,200)
        assert.deepEqual(JSON.parse(result.response.body),{method:'POST',bytes:[0,127,128,255]})
        assert.deepEqual(result.files,{'/input.bin':[0,127,128,255],'/extra.bin':[0,255]})
        assert.equal(result.cancelled,true)
        assert.deepEqual(result.contexts,['slow','fast'])
        assert.equal(result.compiled,'42')
      }finally{await browser.close()}
    }
  }finally{await server.close()}
})
