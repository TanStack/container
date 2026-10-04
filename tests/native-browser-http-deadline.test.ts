import {expect,test} from 'vitest'
import {build} from 'esbuild'
import {chromium,firefox,webkit} from 'playwright'

test('browser request cancellation releases pending connections, writes and upload reads',async()=>{
  const bundled=await build({stdin:{contents:`export {WorkerHTTP} from './src/sandbox/worker-http';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})
  for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    let observationTimer:ReturnType<typeof setTimeout>|undefined
    try{
      const page=await browser.newPage()
      const result=await Promise.race([page.evaluate(async helper=>{
        const url=URL.createObjectURL(new Blob([helper],{type:'text/javascript'}))
        try{
          const {WorkerHTTP}=await new Function('url','return import(url)')(url)
          const results=[]
          for(const abort of [false,true]){
            let started!:()=>void,closed=0
            const writing=new Promise<void>(resolve=>{started=resolve})
            const socket={read:async()=>({type:'end'}),write(){started();return new Promise(()=>{})},async end(){},async close(){closed++}}
            const controller=new AbortController(),reason=Error('Preview closed')
            const client=new WorkerHTTP({connect:async()=>socket},1234,{requestTimeoutMs:abort?1000:20})
            const failure=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal})).catch((error:any)=>error)
            await writing
            if(abort)controller.abort(reason)
            const error=await failure
            results.push({abort,message:error.message,sameReason:error===reason,closed,diagnostic:error.diagnostic})
          }
          for(const stalledCancel of [false,true]){
            let started!:()=>void,cancelReason:unknown,connections=0
            const reading=new Promise<void>(resolve=>{started=resolve})
            const body=new ReadableStream<Uint8Array>({
              pull(){started();return new Promise<void>(()=>{})},
              cancel(reason){cancelReason=reason;if(stalledCancel)return new Promise<void>(()=>{})},
            },{highWaterMark:0})
            const controller=new AbortController(),reason=Error('Upload cancelled')
            const request=new Request('https://preview.invalid/',{method:'POST',body,duplex:'half',signal:controller.signal} as RequestInit)
            // Record the native capability rather than substituting a fake
            // Request body for engines that coerce this input to a string.
            if(request.body!==body){
              void body.cancel(reason).catch(()=>{})
              results.push({stalledCancel,streamRequestSupported:false,contentType:request.headers.get('content-type')})
              continue
            }
            const client=new WorkerHTTP({connect:async()=>{connections++;throw Error('Upload opened a socket')}},1234)
            const failure=client.fetch(request).catch((error:any)=>error)
            await reading;controller.abort(reason)
            const error=await failure
            results.push({stalledCancel,sameReason:error===reason,sameCancelReason:cancelReason===reason,locked:request.body!.locked,connections})
          }
          for(const lateReject of [false,true]){
            let start!:()=>void,resolveConnect!:(socket:unknown)=>void,rejectConnect!:(error:Error)=>void,closed=0,writes=0
            const connecting=new Promise<void>(resolve=>{start=resolve})
            const socket={async close(){closed++},async write(){writes++}}
            const client=new WorkerHTTP({connect:()=>{start();return new Promise((resolve,reject)=>{resolveConnect=resolve;rejectConnect=reject})}},1234)
            const controller=new AbortController(),reason=Error('Connection cancelled')
            const failure=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal})).catch((error:any)=>error)
            await connecting;controller.abort(reason)
            const error=await failure
            if(lateReject)rejectConnect(Error('Late connection failure'));else resolveConnect(socket)
            await new Promise(resolve=>setTimeout(resolve,0))
            results.push({lateReject,sameReason:error===reason,closed,writes})
          }
          for(const bodyPhase of [false,true]){
            let start!:()=>void,reads=0,closed=0
            const reading=new Promise<void>(resolve=>{start=resolve})
            const socket={read(){
              if(bodyPhase&&reads++===0)return Promise.resolve({type:'data',bytes:new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n')})
              start();return new Promise(()=>{})
            },async write(){},async end(){},close(){closed++;return new Promise(()=>{})}}
            const controller=new AbortController(),reason=Error('Response cancelled')
            const client=new WorkerHTTP({connect:async()=>socket},1234)
            const request=client.fetch(new Request('https://preview.invalid/',{signal:controller.signal}))
            const failure=bodyPhase?(await request).text().catch((error:any)=>error):request.catch((error:any)=>error)
            await reading;controller.abort(reason)
            const error=await failure
            results.push({bodyPhase,sameReason:error===reason,closed,error:String(error)})
          }
          return results
        }finally{URL.revokeObjectURL(url)}
      },bundled.outputFiles[0].text),new Promise<never>((_,reject)=>{observationTimer=setTimeout(()=>reject(Error(`${engine.name()} request cancellation control did not settle`)),5000)})])
      expect(result[0],engine.name()).toMatchObject({abort:false,message:'HTTP response timed out',closed:1,diagnostic:{phase:'request headers',writtenBytes:0,receivedBytes:0,timeoutMs:20}})
      expect(result[1],engine.name()).toMatchObject({abort:true,message:'Preview closed',sameReason:true,closed:1})
      const expectedUploads=engine===firefox
        ?[false,true].map(stalledCancel=>({stalledCancel,streamRequestSupported:false,contentType:'text/plain;charset=UTF-8'}))
        :[false,true].map(stalledCancel=>({stalledCancel,sameReason:true,sameCancelReason:true,locked:false,connections:0}))
      expect(result.slice(2,4),engine.name()).toEqual(expectedUploads)
      expect(result.slice(4,6),engine.name()).toEqual([false,true].map(lateReject=>({lateReject,sameReason:true,closed:lateReject?0:1,writes:0})))
      expect(result.slice(6),engine.name()).toEqual([false,true].map(bodyPhase=>({bodyPhase,sameReason:true,closed:1,error:'Error: Response cancelled'})))
    }finally{clearTimeout(observationTimer);await browser.close()}
  }
},30_000)
