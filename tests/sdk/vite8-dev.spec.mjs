import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {collectInstalledClosure} from '../../scripts/collect-installed-closure.mjs'

const sdkRoot=realpathSync(process.env.SDK_OUTPUT),fixture=resolve('fixtures/vite-rolldown-wasm')
const main=value=>`export const value: number = ${value}; if(import.meta.hot) import.meta.hot.accept();`
const html='<html><head></head><body><script type="module" src="/main.ts"></script></body></html>'
const policy={experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000,sharedMemoryPerEngine:{maxBytes:1280*1024*1024,growthReservation:true},workspace:{maxBytes:64*1024*1024}}
let owner,url,snapshot
test.beforeAll(async()=>{
  snapshot=JSON.stringify(await collectInstalledClosure(fixture,['vite','@rolldown/binding-wasm32-wasi']))
  owner=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    if(path==='/fixture.json'){res.setHeader('content-type','application/json');res.end(snapshot);return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside SDK')
      const file=realpathSync(resolve(sdkRoot,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(sdkRoot+sep))throw Error('outside SDK')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>owner.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${owner.address().port}`
})
test.afterAll(async()=>{if(owner)await new Promise(done=>owner.close(done))})

test('packaged Vite8 serves TypeScript and sends HMR after a filesystem edit',async({page},info)=>{
  const nativeSource=`import {mkdtemp,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const root=await mkdtemp(join(tmpdir(),'vite8-dev-control-'));await writeFile(join(root,'index.html'),${JSON.stringify(html)});await writeFile(join(root,'main.ts'),${JSON.stringify(main(42))});
const {createServer}=await import(${JSON.stringify(pathToFileURL(resolve(fixture,'node_modules/vite/dist/node/index.js')).href)});
let server,socket;const evidence={};
try{server=await createServer({root,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();const port=server.httpServer.address().port,base='http://127.0.0.1:'+port;
evidence.html=await(await fetch(base+'/')).text();const client=await(await fetch(base+'/@vite/client')).text();evidence.first=await(await fetch(base+'/main.ts')).text();const token=/const wsToken = "([^"]+)"/.exec(client)?.[1];if(!token)throw Error('Missing WS token');
socket=new WebSocket('ws://127.0.0.1:'+port+'/?token='+token,'vite-hmr');const events=[];socket.addEventListener('message',event=>events.push(JSON.parse(event.data)));
const until=async(test)=>{const deadline=Date.now()+10000;while(!test()){if(Date.now()>deadline)throw Error('HMR timeout');await new Promise(r=>setTimeout(r,20))}};
await until(()=>events.some(e=>e.type==='connected'));await writeFile(join(root,'main.ts'),${JSON.stringify(main(43))});await until(()=>events.some(e=>e.type==='update'));evidence.update=events.find(e=>e.type==='update');evidence.edited=await(await fetch(base+'/main.ts')).text();
}catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}finally{if(socket)socket.close();if(server)await server.close()}console.log(JSON.stringify(evidence));process.exit(evidence.failure?1:0);`
  const native=spawnSync(process.execPath,['--input-type=module','-e',nativeSource],{encoding:'utf8',timeout:15000,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:resolve(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')}})
  const nativePath=info.outputPath('native-vite8-dev.json');await writeFile(nativePath,JSON.stringify({status:native.status,error:native.error?.message,stdout:native.stdout,stderr:native.stderr},null,2));await info.attach('native-vite8-dev.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout.trim().split('\n').at(-1))
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const observed=await page.evaluate(async({policy,html,first,edited})=>{
    const evidence={stages:[],output:'',cleanup:{kind:'Host socket, process and kernel disposal, not graceful guest Vite server.close',completed:[],errors:[]}};let kernel,child,socket,timer
    try{
      const closure=await fetch('/fixture.json').then(r=>r.json())
      const files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
      files['/project/app/index.html']=html;files['/project/app/main.ts']=first
      files['/project/server.mjs']=`import {createServer} from 'vite';console.log('VITE_IMPORTED');const server=await createServer({root:'/project/app',configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:8519,strictPort:true}});console.log('VITE_CREATED');await server.listen();console.log('VITE_READY');`
      kernel=new window.sdk.WorkerKernel(files,policy)
      timer=setTimeout(()=>kernel.close(new Error('Vite dev workflow deadline')),15000)
      child=await kernel.spawn('node',['/project/server.mjs'],{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:'/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'},lifetime:'session',guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000})
      for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')evidence.output+=new TextDecoder().decode(event.bytes);if(evidence.output.includes('VITE_READY'))break;if(!event||event.type==='exit')throw Error('Vite exited before ready: '+evidence.output)}
      evidence.stages.push('listening')
      const http=new window.sdk.WorkerHTTP(kernel,8519),base='http://localhost:8519'
      const request=async(path)=>{const response=await http.fetch(new Request(base+path));if(response.status!==200)throw Error('HTTP '+response.status+' '+path);return response.text()}
      evidence.html=await request('/');const client=await request('/@vite/client');evidence.first=await request('/main.ts');evidence.stages.push('transformed')
      const token=/const wsToken = "([^"]+)"/.exec(client)?.[1];if(!token)throw Error('Missing WS token')
      socket=await window.sdk.WorkerWebSocket.connect(kernel,8519,base,'ws://localhost:8519/?token='+token,['vite-hmr'])
      const connected=await socket.next();if(connected?.type!=='text'||JSON.parse(connected.data).type!=='connected')throw Error('Missing connected event')
      await kernel.writeText('/project/app/main.ts',edited)
      for(let i=0;i<8;i++){const event=await socket.next();if(event?.type!=='text')throw Error('Unexpected HMR event');const message=JSON.parse(event.data);if(message.type==='update'){evidence.update=message;break}}
      evidence.edited=await request('/main.ts');evidence.stages.push('edited')
    }catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
    finally{
      clearTimeout(timer)
      for(const [name,dispose] of [['socket',socket&&(()=>socket.close())],['process',child&&(()=>child.dispose())],['kernel',kernel&&(()=>kernel.close())]]){
        if(!dispose)continue
        try{await dispose();evidence.cleanup.completed.push(name)}catch(error){evidence.cleanup.errors.push({stage:name,name:error.name,message:error.message})}
      }
    }
    return evidence
  },{policy,html,first:main(42),edited:main(43)})
  const evidencePath=info.outputPath('guest-vite8-dev.json');await writeFile(evidencePath,JSON.stringify({sdkRoot,policy,scope:'Declared Lightning CSS WASM alias and Rolldown WASI binding. Default optimizer enabled, local TS fixture only, no dependency prebundle assertion.',expected,observed},null,2));await info.attach('guest-vite8-dev.json',{path:evidencePath,contentType:'application/json'})
  expect(observed.failure,JSON.stringify(observed)).toBeUndefined()
  expect(observed.cleanup.errors).toEqual([])
  expect(observed.cleanup.completed).toEqual(['socket','process','kernel'])
  for(const result of [expected,observed]){expect(result.html).toContain('/@vite/client');expect(result.first).toMatch(/value\s*=\s*42/);expect(result.edited).toMatch(/value\s*=\s*43/);expect(result.update).toMatchObject({type:'update',updates:[{type:'js-update',path:'/main.ts',acceptedPath:'/main.ts'}]})}
})

// Vite intentionally destroys open sockets during close. res.end() queues data,
// so wait for response finish before closing, not for an arbitrary timer tick.
function lifecycleSource(importPath,root,port){return `import {createServer} from ${JSON.stringify(importPath)};
let server;server=await createServer({root:${JSON.stringify(root)},configFile:false,logLevel:'silent',plugins:[{name:'fixture-shutdown',configureServer(dev){dev.middlewares.use('/__shutdown',(_req,res)=>{res.once('finish',async()=>{try{await server.close();console.log('VITE_CLOSED')}catch(error){console.error(error.stack);process.exitCode=1}});res.end('closing')})}}],server:{host:'127.0.0.1',port:${port},strictPort:true}});await server.listen();console.log('VITE_READY');`}

test('packaged Vite8 closes gracefully and restarts on the same guest port',async({page},info)=>{
  const nativeSource=`import {mkdtemp,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {createServer} from 'node:net';
const root=await mkdtemp(join(tmpdir(),'vite8-lifecycle-'));await writeFile(join(root,'index.html'),${JSON.stringify(html)});await writeFile(join(root,'main.ts'),${JSON.stringify(main(42))});
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const source=(${lifecycleSource.toString()})(${JSON.stringify(pathToFileURL(resolve(fixture,'node_modules/vite/dist/node/index.js')).href)},root,port);
const rounds=[];for(let round=0;round<2;round++){
const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const exited=new Promise(r=>child.on('exit',(code,signal)=>r({code,signal})));
const deadline=Date.now()+10000;while(!output.includes('VITE_READY')){if(Date.now()>deadline)throw Error('readiness timeout '+output);await new Promise(r=>setTimeout(r,10))}
const base='http://127.0.0.1:'+port;const served=await(await fetch(base+'/')).text();await(await fetch(base+'/__shutdown')).text();const exit=await exited;let refuses=false;try{await fetch(base+'/')}catch{refuses=true}rounds.push({served,output,exit,refuses});}
console.log(JSON.stringify({rounds}));`
  const native=spawnSync(process.execPath,['--input-type=module','-e',nativeSource],{encoding:'utf8',timeout:15000,env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:resolve(fixture,'node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs')}})
  const nativePath=info.outputPath('native-vite8-lifecycle.json');await writeFile(nativePath,JSON.stringify({status:native.status,error:native.error?.message,stdout:native.stdout,stderr:native.stderr},null,2));await info.attach('native-vite8-lifecycle.json',{path:nativePath,contentType:'application/json'})
  expect(native.status,native.stderr||native.stdout||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout.trim().split('\n').at(-1))
  for(const row of expected.rounds){expect(row.output).toContain('VITE_CLOSED');expect(row.exit).toEqual({code:0,signal:null});expect(row.refuses).toBe(true)}
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const observed=await page.evaluate(async({policy,html,main,source})=>{
    const evidence={rounds:[],cleanupErrors:[]};let kernel,child,timer
    try{
      const closure=await fetch('/fixture.json').then(r=>r.json());const files=Object.fromEntries(Object.entries(closure.files).map(([path,value])=>['/project'+path,Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0))]))
      Object.assign(files,{'/project/app/index.html':html,'/project/app/main.ts':main,'/project/server.mjs':source});kernel=new window.sdk.WorkerKernel(files,policy)
      evidence.socketEvents=[]
      const connect=kernel.connect.bind(kernel);let connectionId=0
      kernel.connect=async(...args)=>{
        const id=++connectionId,record=event=>evidence.socketEvents.push({id,round:evidence.rounds.length-1,stage:evidence.rounds.at(-1)?.shutdownStages.at(-1)?.stage??'before-shutdown',...event})
        try{
          const socket=await connect(...args);record({operation:'connect',port:args[0]})
          for(const operation of ['read','write','close']){
            const original=socket[operation].bind(socket)
            socket[operation]=async(...values)=>{
              try{const result=await original(...values);record({operation,eventType:result?.type,eventError:result?.type==='error'?{code:result.code,name:result.name,message:result.message}:undefined,bytes:operation==='write'?values[0]?.byteLength:result?.bytes?.byteLength});return result}
              catch(error){record({operation,error:{name:error.name,message:error.message,stack:error.stack}});throw error}
            }
          }
          return socket
        }catch(error){record({operation:'connect',error:{name:error.name,message:error.message,stack:error.stack}});throw error}
      }
      for(let round=0;round<2;round++){
        const row={output:'',shutdownStages:[]};evidence.rounds.push(row);timer=setTimeout(()=>kernel.close(new Error('Lifecycle deadline')),15000)
        child=await kernel.spawn('node',['/project/server.mjs'],{cwd:'/project',env:{NAPI_RS_NATIVE_LIBRARY_PATH:'/project/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs'},lifetime:'session',guestWasm:true,webAPIs:true,maxBytes:policy.maxBytes,timeoutMs:15000})
        for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')row.output+=new TextDecoder().decode(event.bytes);if(row.output.includes('VITE_READY'))break;if(!event||event.type==='exit')throw Error('Exit before ready '+row.output)}
        const http=new window.sdk.WorkerHTTP(kernel,8519),base='http://localhost:8519';row.served=await(await http.fetch(new Request(base+'/'))).text()
        row.shutdownStages.push({stage:'before-request'})
        const request=new Request(base+'/__shutdown')
        const record=stage=>row.shutdownStages.push({stage,aborted:request.signal.aborted,reason:request.signal.reason===undefined?null:String(request.signal.reason)})
        record('request-created')
        request.signal.addEventListener('abort',()=>record('request-aborted'),{once:true})
        try{
          record('before-fetch')
          const response=await http.fetch(request)
          record('fetch-resolved');row.shutdownResponse={status:response.status,bodyUsed:response.bodyUsed,headers:[...response.headers]}
          record('before-body')
          row.shutdown=await response.text()
          record('body-consumed')
        }catch(error){record('shutdown-error');throw error}
        for(;;){const event=await child.next();if(event?.type==='stdout'||event?.type==='stderr')row.output+=new TextDecoder().decode(event.bytes);if(!event||event.type==='exit')break}
        row.exit=await child.wait();row.refuses=false;try{const socket=await kernel.connect(8519);await socket.close()}catch{row.refuses=true}
        clearTimeout(timer);await child.dispose();child=null
      }
    }catch(error){evidence.failure={name:error.name,message:error.message,stack:error.stack}}
    finally{clearTimeout(timer);if(child)try{await child.dispose()}catch(error){evidence.cleanupErrors.push(error.message)};if(kernel)try{kernel.close()}catch(error){evidence.cleanupErrors.push(error.message)}}
    return evidence
  },{policy,html,main:main(42),source:lifecycleSource('vite','/project/app',8519)})
  const path=info.outputPath('guest-vite8-lifecycle.json');await writeFile(path,JSON.stringify({sdkRoot,policy,expected,observed},null,2));await info.attach('guest-vite8-lifecycle.json',{path,contentType:'application/json'})
  expect(observed.failure,JSON.stringify(observed)).toBeUndefined();expect(observed.cleanupErrors).toEqual([]);expect(observed.rounds).toHaveLength(2)
  for(const row of observed.rounds){expect(row.served).toContain('/@vite/client');expect(row.shutdown).toBe('closing');expect(row.output).toContain('VITE_CLOSED');expect(row.exit.exitCode).toBe(0);expect(row.refuses).toBe(true)}
})
