import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/'+name,readFileSync('fixtures/install-start-wasm/'+name,'utf8')]))

for(const projectRoot of ['/','/project'])test(`installed guest Vite executes modules in the isolated preview at ${projectRoot}`,async({page},info)=>{
  const diagnostics:string[]=[]
  page.on('pageerror',error=>diagnostics.push(error.message))
  page.on('console',message=>{if(message.type()==='error'||message.text().startsWith('HMR trace:'))diagnostics.push(message.text())})
  await page.goto('/sandbox.html')
  try{
    await page.evaluate(async({files,projectRoot})=>{
      const {WorkerKernel,WorkerHTTP,WorkerWebSocket,URLPreview}=window.sandboxLab
      const prefix=projectRoot==='/'?'':projectRoot
      const kernel=new WorkerKernel(Object.fromEntries(Object.entries(files).map(([path,value])=>[prefix+path,value])),{maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
      Object.assign(window,{installedPreviewKernel:kernel})
      await kernel.install({ignoreScripts:true,cwd:projectRoot})
      await kernel.writeText(prefix+'/index.html','<html><head><title>Installed Vite</title></head><body><button id="count"></button><p id="message"></p><script type="module" src="/main.ts"></script></body></html>')
      await kernel.writeText(prefix+'/message.ts','export const message: string = "first version";')
      await kernel.writeText(prefix+'/main.ts',`import {message} from './message';let count: number=42;const button=document.querySelector('#count');button.textContent=String(count);button.addEventListener('click',()=>button.textContent=String(++count));document.querySelector('#message').textContent=message;if(import.meta.hot)import.meta.hot.accept('./message',next=>document.querySelector('#message').textContent=next.message);`)
      await kernel.writeText(prefix+'/main.ts',(await kernel.readText(prefix+'/main.ts'))+`if(import.meta.hot)for(const event of ['vite:beforeUpdate','vite:beforeFullReload','vite:invalidate'])import.meta.hot.on(event,payload=>console.debug('HMR trace:',event,JSON.stringify(payload)));`)
      await kernel.writeText(prefix+'/server.mjs',`import {createServer} from 'vite';import fs from 'node:fs';
        fs.watch('.',{recursive:true},(event,path)=>console.log('RAW',event,path));
        const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:8514,strictPort:true}});
        server.watcher.on('ready',()=>console.log('WATCH_READY'));
        server.watcher.on('all',(event,path)=>console.log('WATCH',event,path));
        await server.listen();console.log('VITE_READY');`)
      const server=await kernel.spawn('node',['server.mjs'],{cwd:projectRoot,lifetime:'session',guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000})
      let output=''
      for(;;){
        const event=await server.next()
        if(event?.type==='stdout'||event?.type==='stderr')output+=new TextDecoder().decode(event.bytes)
        if(output.includes('VITE_READY'))break
        if(!event||event.type==='exit')throw new Error('Vite startup failed: '+output)
      }
      const logs:string[]=[];Object.assign(window,{installedServerLogs:logs})
      void(async()=>{try{for(;;){const event=await server.next();if(event?.type==='stdout'||event?.type==='stderr'){if(logs.length<200)logs.push(new TextDecoder().decode(event.bytes))}else break}}catch{}})()
      const preview=await URLPreview.mount(document.querySelector('#preview')!,{origin:'http://127.0.0.1:4200',server:new WorkerHTTP(kernel,8514),connectWebSocket:(url,protocols)=>WorkerWebSocket.connect(kernel,8514,'http://127.0.0.1:4200',url,protocols)})
      Object.assign(window,{installedPreview:preview})
    },{files,projectRoot})
    const preview=page.frameLocator('#preview iframe')
    await expect(preview.locator('#count')).toHaveText('42')
    await preview.locator('#count').click()
    await expect(preview.locator('#count')).toHaveText('43')
    await expect(preview.locator('#message')).toHaveText('first version')
    await page.evaluate(async projectRoot=>{
      const kernel=(window as any).installedPreviewKernel
      await kernel.writeText((projectRoot==='/'?'':projectRoot)+'/message.ts','export const message: string = "second version";')
    },projectRoot)
    // The imported module changes without reloading or resetting the clicked counter.
    await expect(preview.locator('#message')).toHaveText('second version')
    await expect(preview.locator('#count')).toHaveText('43')
    // Retain explicit reload coverage too. No host compiler or prebuilt application assets.
    const frame=page.frames().find(frame=>frame.url()==='http://127.0.0.1:4200/')!
    await frame.evaluate(()=>location.reload())
    await expect(preview.locator('#message')).toHaveText('second version')
    await expect(preview.locator('#count')).toHaveText('42')
    expect(diagnostics.filter(message=>/WebSocket|websocket|vite.*failed to connect/i.test(message))).toEqual([])
    await info.attach('preview.png',{body:await page.screenshot(),contentType:'image/png'})
  }finally{
    await info.attach('server-watch.json',{body:JSON.stringify(await page.evaluate(()=>(window as any).installedServerLogs??[])),contentType:'application/json'})
    await info.attach('preview-diagnostics.json',{body:JSON.stringify(diagnostics),contentType:'application/json'})
    await page.evaluate(()=>{(window as any).installedPreview?.close();(window as any).installedPreviewKernel?.close()})
  }
})
