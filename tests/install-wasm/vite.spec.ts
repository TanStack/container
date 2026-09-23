import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/'+name,readFileSync('fixtures/install-start-wasm/'+name,'utf8')]))
test('installed Vite session serves host sockets and observes workspace edits',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
    try{
      await kernel.install({ignoreScripts:true})
      await kernel.writeText('/index.html','<html><head></head><body><div id="app"></div><script type="module" src="/main.ts"></script></body></html>')
      await kernel.writeText('/main.ts','export const value: number = 42;')
      await kernel.writeText('/server.mjs',`import {createServer} from 'vite';const server=await createServer({root:'/',configFile:false,server:{host:'127.0.0.1',port:8513,strictPort:true}});await server.listen();console.log('VITE_READY');`)
      const server=await kernel.spawn('node',['/server.mjs'],{lifetime:'session',guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000})
      const events=[]
      for(;;){
        const event=await server.next();events.push(event)
        if(event?.type==='stdout'&&new TextDecoder().decode(event.bytes).includes('VITE_READY'))break
        if(!event||event.type==='exit')return {events,stopped:await server.wait()}
      }
      const request=async(path:string)=>{
        const socket=await kernel.connect(8513)
        try{
          await socket.write(new TextEncoder().encode('GET '+path+' HTTP/1.1\r\nHost: localhost:8513\r\nConnection: close\r\n\r\n'))
          const decoder=new TextDecoder();let wire=''
          for(;;){const event=await socket.read();if(event?.type!=='data')break;wire+=decoder.decode(event.bytes,{stream:true});if(wire.length>2*1024*1024)throw new Error('Probe response exceeds 2 MiB')}
          return wire+decoder.decode()
        }finally{await socket.close()}
      }
      const index=await request('/'),first=await request('/main.ts')
      await kernel.writeText('/main.ts','export const value: number = 43;')
      // Watch delivery is asynchronous. Re-request the same URL, without cache busting.
      let edited=''
      for(let attempt=0;attempt<50;attempt++){
        edited=await request('/main.ts')
        if(edited.includes('value = 43'))break
        await new Promise(resolve=>setTimeout(resolve,100))
      }
      const http=new window.sandboxLab.WorkerHTTP(kernel,8513)
      const response=await http.fetch(new Request('http://localhost:8513/main.ts'))
      const adapted={status:response.status,type:response.headers.get('content-type'),text:await response.text()}
      await server.dispose()
      return {events,index,first,edited,adapted}
    }finally{kernel.close()}
  },files)
  await info.attach('vite-session.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.stopped,JSON.stringify(result)).toBeUndefined()
  expect(result.index).toContain('HTTP/1.1 200')
  expect(result.index).toContain('/@vite/client')
  expect(result.first).toContain('value = 42')
  expect(result.edited).toContain('value = 43')
  expect(result.edited).not.toContain(': number')
  expect(result.adapted?.status).toBe(200)
  expect(result.adapted?.type).toContain('javascript')
  expect(result.adapted?.text).toContain('value = 43')
})
for(const phase of ['serve','build','disk'])test(`installed Vite with published WASM compilers: ${phase}`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,phase})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{maxBytes:256*1024*1024,workspace:{maxBytes:128*1024*1024}})
    let stage='install'
    try{
      const installation=await kernel.install({ignoreScripts:true});stage=phase
      await kernel.writeText('/index.html','<html><body><div id="app"></div><script type="module" src="/main.ts"></script></body></html>')
      await kernel.writeText('/main.ts','const value: number = 42; document.querySelector("#app").textContent = String(value);')
      await kernel.writeText('/probe.mjs',phase==='serve'?`
        import {createServer} from 'vite';import http from 'node:http';
        const server=await createServer({root:'/',configFile:false,server:{host:'127.0.0.1',port:8512,strictPort:true}});
        try{
          await server.listen();
          const get=path=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:8512,path},res=>{let text='';res.on('data',bytes=>text+=bytes);res.on('end',()=>resolve({status:res.statusCode,text}));res.on('error',reject)}).on('error',reject));
          const index=await get('/'),module=await get('/main.ts');console.log(JSON.stringify({index,module}));
        }finally{await server.close()}
      `:`
        import {build} from 'vite';import fs from 'node:fs';
        const outputs=[],disk=[];
        for(const value of [42,43]){
          ${phase==='disk'?`fs.mkdirSync('/dist',{recursive:true});fs.writeFileSync('/dist/stale.txt','remove me');`:''}
          fs.writeFileSync('/main.ts','const value: number = '+value+'; document.querySelector("#app").textContent = String(value);');
          const result=await build({root:'/',configFile:false,build:{write:${phase==='disk'}}});
          outputs.push(result.output.filter(x=>x.type==='chunk').map(x=>x.code).join('\\n'));
          ${phase==='disk'?`disk.push({stale:fs.existsSync('/dist/stale.txt'),html:fs.readFileSync('/dist/index.html','utf8'),chunks:result.output.filter(x=>x.type==='chunk').map(x=>({name:x.fileName,code:fs.readFileSync('/dist/'+x.fileName,'utf8')}))});`:''}
        }
        console.log(JSON.stringify({outputs,disk}));
      `)
      const execution=await kernel.runModule('/probe.mjs',{guestWasm:true,webAPIs:true,maxBytes:256*1024*1024,timeoutMs:30000})
      return {stage,installation,execution}
    }catch(error){return {stage,error:String(error)}}finally{kernel.close()}
  },{files,phase})
  await info.attach('wasm-vite.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.error,JSON.stringify(result)).toBeUndefined()
  expect(result.installation?.packageAliases).toContainEqual({installPath:'/node_modules/esbuild',name:'esbuild-wasm',version:'0.28.2'})
  expect(result.execution?.exitCode,result.execution?.stderr).toBe(0)
  const output=JSON.parse(result.execution!.stdout.trim().split('\n').at(-1)!)
  if(phase==='serve'){
    expect(output.index.status).toBe(200);expect(output.index.text).toContain('/@vite/client')
    expect(output.module.status).toBe(200);expect(output.module.text).toContain('42');expect(output.module.text).not.toContain(': number')
  }else{
    expect(output.outputs).toHaveLength(2)
    expect(output.outputs[0]).toContain('42');expect(output.outputs[1]).toContain('43')
    for(const code of output.outputs)expect(code).not.toContain(': number')
    if(phase==='disk')for(let i=0;i<2;i++){
      expect(output.disk[i].stale).toBe(false)
      expect(output.disk[i].chunks.length).toBeGreaterThan(0)
      expect(output.disk[i].chunks.map((x:{code:string})=>x.code).join('\n')).toBe(output.outputs[i])
      for(const chunk of output.disk[i].chunks)expect(output.disk[i].html).toContain(chunk.name)
    }
  }
})
