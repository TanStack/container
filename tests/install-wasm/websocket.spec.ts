import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/'+name,readFileSync('fixtures/install-start-wasm/'+name,'utf8')]))

test('installed Vite upgrades a virtual socket and sends an HMR update',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const {WorkerKernel,WorkerHTTP}=window.sandboxLab
    const kernel=new WorkerKernel(files,{maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
    let timer:ReturnType<typeof setTimeout>|undefined
    try{
      await kernel.install({ignoreScripts:true})
      await kernel.writeText('/main.ts','export const value: number=42; if(import.meta.hot) import.meta.hot.accept();')
      await kernel.writeText('/server.mjs',`import {createServer} from 'vite';const server=await createServer({root:'/',configFile:false,server:{host:'127.0.0.1',port:8515,strictPort:true}});await server.listen();console.log('VITE_READY');`)
      const server=await kernel.spawn('node',['/server.mjs'],{lifetime:'session',guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000})
      let output=''
      for(;;){const event=await server.next();if(event?.type==='stdout'||event?.type==='stderr')output+=new TextDecoder().decode(event.bytes);if(output.includes('VITE_READY'))break;if(!event||event.type==='exit')throw new Error(output)}
      const http=new WorkerHTTP(kernel,8515)
      const client=await (await http.fetch(new Request('http://localhost:8515/@vite/client'))).text()
      const token=/const wsToken = "([^"]+)"/.exec(client)?.[1]
      if(!token)throw new Error('Vite client did not expose its handshake token')
      await (await http.fetch(new Request('http://localhost:8515/main.ts'))).text()
      const socket=await kernel.connect(8515)
      timer=setTimeout(()=>kernel.close(new Error('WebSocket probe timed out')),15000)
      await socket.write(new TextEncoder().encode(`GET /?token=${token} HTTP/1.1\r\nHost: localhost:8515\r\nOrigin: http://localhost:8515\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`))
      let buffer=new Uint8Array(0)
      const more=async()=>{
        const event=await socket.read()
        if(event?.type!=='data')throw new Error('Socket ended: '+JSON.stringify(event))
        const bytes=new Uint8Array(buffer.length+event.bytes.length);bytes.set(buffer);bytes.set(event.bytes,buffer.length);buffer=bytes
        if(buffer.length>1024*1024)throw new Error('Probe frame limit exceeded')
      }
      let headerEnd=-1
      while(headerEnd<0){await more();for(let i=0;i+3<buffer.length;i++)if(buffer[i]===13&&buffer[i+1]===10&&buffer[i+2]===13&&buffer[i+3]===10){headerEnd=i+4;break}}
      const handshake=new TextDecoder().decode(buffer.slice(0,headerEnd));buffer=buffer.slice(headerEnd)
      if(!handshake.startsWith('HTTP/1.1 101'))return {handshake}
      // Probe decoder for Vite's small, unfragmented server messages, not a public WebSocket implementation.
      const frame=async()=>{
        while(buffer.length<2)await more()
        if(!(buffer[0]&128)||buffer[0]&112||buffer[1]&128)throw new Error('Unexpected server frame flags')
        const opcode=buffer[0]&15;let length=buffer[1]&127,offset=2
        if(length===127)throw new Error('Probe does not accept 64-bit frame lengths')
        if(length===126){while(buffer.length<4)await more();length=buffer[2]*256+buffer[3];offset=4}
        while(buffer.length<offset+length)await more()
        const bytes=buffer.slice(offset,offset+length);buffer=buffer.slice(offset+length)
        return {opcode,bytes:[...bytes],text:new TextDecoder().decode(bytes)}
      }
      const connected=await frame()
      await kernel.writeText('/main.ts','export const value: number=43; if(import.meta.hot) import.meta.hot.accept();')
      const update=await frame()
      // Masked normal-close frame, code 1000. No native network is involved.
      await socket.write(new Uint8Array([0x88,0x82,1,2,3,4,3^1,232^2]))
      const closed=await frame()
      await socket.close()
      const transport=await window.sandboxLab.WorkerWebSocket.connect(kernel,8515,'http://localhost:8515','ws://localhost:8515/?token='+token,['vite-hmr'])
      const transportConnected=await transport.next()
      await kernel.writeText('/main.ts','export const value: number=44; if(import.meta.hot) import.meta.hot.accept();')
      const transportUpdate=await transport.next()
      await transport.close()
      const transportClosed=await transport.next()
      await server.dispose()
      return {handshake,connected,update,closed,transportConnected,transportUpdate,transportClosed}
    }finally{clearTimeout(timer);kernel.close()}
  },files)
  await info.attach('vite-websocket.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.handshake).toContain('101 Switching Protocols')
  expect(result.handshake.toLowerCase()).toContain('sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo=')
  expect(result.handshake.toLowerCase()).toContain('sec-websocket-protocol: vite-hmr')
  expect(result.connected?.opcode).toBe(1)
  expect(JSON.parse(result.connected!.text)).toEqual({type:'connected'})
  expect(result.update?.opcode).toBe(1)
  expect(JSON.parse(result.update!.text)).toMatchObject({type:'update',updates:[{type:'js-update',path:'/main.ts',acceptedPath:'/main.ts'}]})
  expect(result.closed?.opcode).toBe(8)
  expect(result.closed?.bytes).toEqual([3,232])
  expect(result.transportConnected).toMatchObject({type:'text',data:JSON.stringify({type:'connected'})})
  expect(result.transportUpdate?.type).toBe('text')
  expect(JSON.parse(result.transportUpdate!.data as string)).toMatchObject({type:'update',updates:[{path:'/main.ts'}]})
  expect(result.transportClosed).toMatchObject({type:'close',code:1000})
})
