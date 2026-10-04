import {expect,test} from 'vitest'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {chromium,firefox,webkit} from 'playwright'

test('real worker file and port waits ignore a notification until their reply is published',async()=>{
  const bundled=await build({stdin:{resolveDir:process.cwd(),contents:[
    "import {NativeSyncFileClient} from './src/native/sync-file-bridge';",
    "import {NativeSyncPortClient} from './src/native/sync-port-bridge';",
    'onmessage=({data,ports})=>{try{',
    'const client=data.kind==="file"?new NativeSyncFileClient(ports[0],data.lane):new NativeSyncPortClient(ports[0],data.lane);',
    'const value=data.kind==="file"?client.call("readFile",["/project/value.txt"]):client.allocate();',
    'client.close();postMessage({value});',
    '}catch(error){postMessage({error:String(error)})}};',
  ].join('\n')},bundle:true,write:false,platform:'browser',format:'iife'})
  const server=createServer((_request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    response.setHeader('Content-Type','text/html')
    response.end('<!doctype html>')
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    for(const engine of [chromium,firefox,webkit]){
      const browser=await engine.launch()
      try{
        const page=await browser.newPage()
        await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port)
        const rows=await page.evaluate(async source=>{
          const rows=[]
          for(const kind of ['file','port']){
            const lane=new SharedArrayBuffer(kind==='file'?16+65536:8)
            const header=new Int32Array(lane,0,kind==='file'?4:2)
            const channel=new MessageChannel()
            const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
            const worker=new Worker(url)
            let timer:ReturnType<typeof setTimeout>|undefined
            let control:Promise<void>|undefined
            let notified=0
            try{
              const result=new Promise<Record<string,unknown>>((resolve,reject)=>{
                timer=setTimeout(()=>reject(Error('Reply worker did not settle')),5000)
                worker.onmessage=event=>resolve(event.data)
                worker.onerror=event=>reject(Error(event.message))
                channel.port1.onmessage=()=>{
                  control=(async()=>{
                    // Wake an actual blocked wait while the predicate is still
                    // zero, then publish its real response on a later task.
                    for(let attempt=0;attempt<1000;attempt++){
                      notified=Atomics.notify(header,0)
                      if(notified===1)break
                      await new Promise(resolve=>setTimeout(resolve,1))
                    }
                    if(notified!==1)throw Error('Worker never entered its wait')
                    await new Promise(resolve=>setTimeout(resolve,20))
                    if(kind==='file'){
                      const bytes=new TextEncoder().encode(JSON.stringify({value:'current file reply'}))
                      new Uint8Array(lane,16).set(bytes)
                      Atomics.store(header,1,bytes.length)
                      Atomics.store(header,2,2)
                    }else Atomics.store(header,1,5173)
                    Atomics.store(header,0,1)
                    Atomics.notify(header,0)
                  })()
                  control.catch(reject)
                }
                worker.postMessage({kind,lane},[channel.port2])
              })
              const actual=await result
              await control
              rows.push({kind,notified,...actual})
            }finally{
              clearTimeout(timer);worker.terminate()
              channel.port1.close();channel.port2.close();URL.revokeObjectURL(url)
            }
          }
          return rows
        },bundled.outputFiles[0]!.text)
        expect(rows,engine.name()).toEqual([
          {kind:'file',notified:1,value:'current file reply'},
          {kind:'port',notified:1,value:5173},
        ])
      }finally{await browser.close()}
    }
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
},30_000)
