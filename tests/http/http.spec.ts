import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'request URL, POST bytes, response headers and trailers':`
    import http from 'node:http';import {Buffer} from 'node:buffer';
    const server=http.createServer((req,res)=>{let text='';req.setEncoding('utf8');req.on('data',x=>text+=x);req.on('end',()=>{res.setHeader('x-request',req.method+' '+req.url);res.setHeader('set-cookie',['a=1','b=2']);res.setHeader('Trailer','x-sum');res.writeHead(201);res.write(text.toUpperCase());res.addTrailers({'x-sum':'yes'});res.end()})});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const result=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/hello?q=1',method:'POST'},res=>{let text='';res.setEncoding('utf8');res.on('data',x=>text+=x);res.on('end',()=>resolve([res.statusCode,res.headers['x-request'],res.headers['set-cookie'],text,res.trailers,res.complete]))});req.on('error',reject);req.end('hello 🦊')});await new Promise(r=>server.close(r));console.log(JSON.stringify(result));`,
  'large streaming echo with slow consumer':`
    import http from 'node:http';import {Buffer} from 'node:buffer';import {Writable} from 'node:stream';import {pipeline} from 'node:stream/promises';
    const server=http.createServer((req,res)=>req.pipe(res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
    let size=0,sum=0;const done=new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,method:'POST'},res=>{pipeline(res,new Writable({highWaterMark:1024,write(bytes,enc,cb){size+=bytes.length;for(const byte of bytes)sum+=byte;setTimeout(cb,1)}})).then(resolve,reject)});req.on('error',reject);req.end(Buffer.alloc(256*1024,7))});await done;await new Promise(r=>server.close(r));console.log(JSON.stringify([size,sum]));`,
  'HEAD and no-content responses do not deliver bodies':`
    import http from 'node:http';const server=http.createServer((req,res)=>{res.statusCode=req.url==='/empty'?204:200;res.setHeader('content-length','5');res.end('hello')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const results=[];
    for(const [method,path] of [['HEAD','/'],['GET','/empty']])results.push(await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,method,path},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve([res.statusCode,text,res.complete]))});req.on('error',reject);req.end()}));await new Promise(r=>server.close(r));console.log(JSON.stringify(results));`,
  '100 continue then request body':`
    import http from 'node:http';const server=http.createServer((req,res)=>{let text='';req.on('data',x=>text+=x);req.on('end',()=>res.end(text))});await new Promise(r=>server.listen(0,'127.0.0.1',r));const seen=[];
    await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,method:'POST',headers:{Expect:'100-continue','content-length':5}},res=>{res.on('data',x=>seen.push(x.toString()));res.on('end',resolve)});req.on('error',reject);req.on('continue',()=>{seen.push('continue');req.end('hello')});req.flushHeaders()});await new Promise(r=>server.close(r));console.log(JSON.stringify(seen));`,
  'request callbacks retain ALS across asynchronous response work':`
    import http from 'node:http';import {AsyncLocalStorage} from 'node:async_hooks';const als=new AsyncLocalStorage();let server;const seen=[];
    await als.run('server',()=>new Promise(resolve=>{server=http.createServer(async(req,res)=>{seen.push(als.getStore());await Promise.resolve();res.end(als.getStore())});server.listen(0,'127.0.0.1',resolve)}));
    await als.run('client',()=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:server.address().port},res=>{seen.push(als.getStore());res.on('data',x=>seen.push(x.toString(),als.getStore()));res.on('end',resolve)}).on('error',reject)}));await new Promise(r=>server.close(r));console.log(JSON.stringify(seen));`,
  'header validation and mutation after sending':`
    import http from 'node:http';const seen=[];for(const [name,value] of [['bad name','ok'],['ok','bad\\r\\nvalue'],['ok',undefined]]){try{http.validateHeaderName(name);http.validateHeaderValue(name,value)}catch(e){seen.push(e.code)}}
    const server=http.createServer((req,res)=>{res.setHeader('X-One','1');res.appendHeader('X-One','2');seen.push(res.getHeaderNames(),res.getHeader('x-one'));res.flushHeaders();try{res.setHeader('x-two','2')}catch(e){seen.push(e.code)}res.end('ok')});await new Promise(r=>server.listen(0,'127.0.0.1',r));await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port},res=>{res.resume();res.on('end',resolve)}).on('error',reject));await new Promise(r=>server.close(r));console.log(JSON.stringify(seen));`,
  'upgrade delivers untouched protocol bytes':`
    import http from 'node:http';import net from 'node:net';const seen=[];const server=http.createServer();server.on('upgrade',(req,socket,head)=>{seen.push(req.url,head.toString());socket.end('upgraded')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const socket=net.connect(server.address().port,'127.0.0.1');let text='';socket.on('data',x=>text+=x);const done=new Promise(r=>socket.on('close',r));socket.end('GET /ws HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: Upgrade\\r\\nUpgrade: demo\\r\\n\\r\\nfirst-frame');await done;await new Promise(r=>server.close(r));console.log(JSON.stringify([...seen,text]));`,
  'pipelined responses remain ordered':`
    import http from 'node:http';import net from 'node:net';const server=http.createServer((req,res)=>{res.sendDate=false;res.setHeader('content-length','2');setTimeout(()=>res.end(req.url),req.url==='/a'?10:0)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const socket=net.connect(server.address().port,'127.0.0.1');let text='';socket.on('data',x=>text+=x);const done=new Promise(r=>socket.on('close',r));socket.write('GET /a HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\nGET /b HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n');await done;await new Promise(r=>server.close(r));console.log(JSON.stringify([text.split('HTTP/1.1 200 OK').length-1,text.indexOf('/a')<text.indexOf('/b'),text.endsWith('/b')]));`,
  'ambiguous framing and invalid chunk sizes reject':`
    import http from 'node:http';import net from 'node:net';const seen=[];const server=http.createServer((req,res)=>{req.on('error',()=>{});req.resume()});server.on('clientError',(error,socket)=>{seen.push(error.code);socket.destroy()});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    for(const wire of ['POST / HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 1\\r\\nContent-Length: 1\\r\\n\\r\\nx','POST / HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 1\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n0\\r\\n\\r\\n','GET / HTTP/1.1\\r\\nBad Name: value\\r\\n\\r\\n','POST / HTTP/1.1\\r\\nHost: x\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\nnope\\r\\n']){const socket=net.connect(server.address().port,'127.0.0.1');socket.on('error',()=>{});const done=new Promise(r=>socket.on('close',r));socket.end(wire);await done}await new Promise(r=>server.close(r));console.log(JSON.stringify(seen));`,
  'fragmented headers and chunk trailers decode incrementally':`
    import http from 'node:http';import net from 'node:net';const seen=[];const server=http.createServer((req,res)=>{let text='';req.on('data',x=>text+=x);req.on('end',()=>{seen.push(text,req.trailers,req.complete);res.end('ok')})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const socket=net.connect(server.address().port,'127.0.0.1');socket.resume();const done=new Promise(r=>socket.on('close',r));
    for(const part of ['POST / HTTP/1.','1\\r','\\nHost: x\\r\\nConnection: close\\r\\nTransfer-Encoding: chunked\\r\\n\\r','\\n3;foo=bar\\r','\\nabc\\r','\\n2\\r\\nde\\r\\n0\\r\\nX-End: yes\\r','\\n\\r\\n']){socket.write(part);await new Promise(r=>setTimeout(r,1))}await done;await new Promise(r=>server.close(r));console.log(JSON.stringify(seen));`,
  'header-size limit does not prevent a fresh valid request':`
    import http from 'node:http';import net from 'node:net';const seen=[];const server=http.createServer({maxHeaderSize:128},(req,res)=>res.end('healthy'));server.on('clientError',(error,socket)=>{seen.push(error.code);socket.destroy()});await new Promise(r=>server.listen(0,'127.0.0.1',r));const socket=net.connect(server.address().port,'127.0.0.1');socket.on('error',()=>{});const done=new Promise(r=>socket.on('close',r));socket.end('GET / HTTP/1.1\\r\\nHost: x\\r\\nX-Long: '+'a'.repeat(256)+'\\r\\n\\r\\n');await done;await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port},res=>{res.on('data',x=>seen.push(x.toString()));res.on('end',resolve)}).on('error',reject));await new Promise(r=>server.close(r));console.log(JSON.stringify(seen));`,
  'abort signal cancels a pending response and releases the server':`
    import http from 'node:http';const controller=new AbortController();const server=http.createServer((req,res)=>controller.abort());await new Promise(r=>server.listen(0,'127.0.0.1',r));const seen=[];await new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port:server.address().port,signal:controller.signal});req.on('error',e=>seen.push(e.name,e.code));req.on('close',resolve)});await new Promise(r=>server.close(r));console.log(JSON.stringify(seen));`,
  'truncated response reports aborted rather than successful end':`
    import http from 'node:http';import net from 'node:net';const server=net.createServer(socket=>{socket.once('data',()=>socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: 10\\r\\n\\r\\nshort'))});await new Promise(r=>server.listen(0,'127.0.0.1',r));const seen=[];await new Promise(resolve=>http.get({host:'127.0.0.1',port:server.address().port},res=>{res.resume();res.on('aborted',()=>seen.push('aborted'));res.on('error',e=>seen.push(e.code));res.on('end',()=>seen.push('end'));res.on('close',()=>{seen.push(res.complete);resolve()})}).on('error',()=>{}));await new Promise(r=>server.close(r));console.log(JSON.stringify(seen));`,
}
for(const [name,source] of Object.entries(cases))for(const guestWasm of [false,true])test(`${name} (${guestWasm?'guest-wasm':'baseline'})`,async({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000});expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm})=>{const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source});try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,maxBytes:32*1024*1024,timeoutMs:10000})}finally{kernel.close()}},{source,guestWasm})
  await info.attach('http.json',{body:JSON.stringify({node:node.stdout,nodeVersion:process.version,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(node.stdout)
})

test('host HTTP bytes reach a guest server and return a complete wire response',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/server.mjs':`import http from 'node:http';const server=http.createServer((req,res)=>{let text='';req.on('data',x=>text+=x);req.on('end',()=>{res.sendDate=false;res.writeHead(201,{'Content-Length':'5','Connection':'close'});res.end(text.toUpperCase());server.close()})});server.listen(8291,()=>console.log('ready'));`})
    let ready!:()=>void;const listening=new Promise<void>(r=>ready=r)
    try{const run=kernel.runModule('/server.mjs',{guestWasm:true,timeoutMs:5000,onOutput:(_level,text)=>{if(text.includes('ready'))ready()}});await listening
      const socket=await kernel.connect(8291);const encoder=new TextEncoder();await socket.write(encoder.encode('POST / HTTP/1.1\r\nHost: preview\r\nContent-Length: 5\r\n\r\nhello'));await socket.end();let wire=''
      for(;;){const event=await socket.read();if(event?.type!=='data')break;wire+=new TextDecoder().decode(event.bytes)}await socket.close();return {wire,run:await run}
    }finally{kernel.close()}
  })
  expect(result.run.exitCode,result.run.stderr).toBe(0);expect(result.wire).toBe('HTTP/1.1 201 Created\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHELLO')
})

test('incomplete headers time out and the listener serves a subsequent request',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/server.mjs':`import http from 'node:http';const server=http.createServer({headersTimeout:50,requestTimeout:200},(req,res)=>{res.end('healthy');server.close()});server.listen(8292,()=>console.log('ready'));`})
    let ready!:()=>void;const listening=new Promise<void>(r=>ready=r)
    try{const run=kernel.runModule('/server.mjs',{guestWasm:true,timeoutMs:5000,onOutput:(_level,text)=>{if(text.includes('ready'))ready()}});await listening;const wires=[]
      for(const wire of ['GET / HTTP/1.1\r\nHost: unfinished','GET / HTTP/1.1\r\nHost: preview\r\nConnection: close\r\n\r\n']){const socket=await kernel.connect(8292);await socket.write(new TextEncoder().encode(wire));let text='';for(;;){const event=await socket.read();if(event?.type!=='data')break;text+=new TextDecoder().decode(event.bytes)}await socket.close();wires.push(text)}return {wires,run:await run}
    }finally{kernel.close()}
  })
  expect(result.run.exitCode,result.run.stderr).toBe(0);expect(result.wires[0]).toContain('408 Request Timeout');expect(result.wires[1]).toContain('200 OK');expect(result.wires[1]).toContain('healthy')
})

for(const site of ['request','request body','response body'])test(`a ${site} handler exception fails execution rather than being hidden as a parse error`,async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async site=>{
    const handler=site==='request'?`()=>{throw Error('handler failed')}`:site==='request body'?`req=>req.on('data',()=>{throw Error('handler failed')})`:`(req,res)=>res.end('body')`
    const callback=site==='response body'?`res=>res.on('data',()=>{throw Error('handler failed')})`:`()=>{}`
    const kernel=new window.sandboxLab.WorkerKernel({'/bad.mjs':`import http from 'node:http';const server=http.createServer(${handler});server.listen(8293,()=>{const req=http.request({host:'127.0.0.1',port:8293,method:'POST'},${callback});req.on('error',()=>{});req.end('body')});`,'/good.mjs':`import http from 'node:http';http.createServer().listen(8293).unref();console.log('recovered')`})
    try{return {bad:await kernel.runModule('/bad.mjs',{guestWasm:true,timeoutMs:2000}),good:await kernel.runModule('/good.mjs',{guestWasm:true})}}finally{kernel.close()}
  },site)
  expect(result.bad.exitCode).toBe(1);expect(result.bad.stderr).toContain('handler failed');expect(result.good.exitCode,result.good.stderr).toBe(0);expect(result.good.stdout).toBe('recovered\n')
})
