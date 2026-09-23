import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'DNS literal addresses, callback ordering and promisified results':`
    import dns from 'node:dns';import promises from 'node:dns/promises';import {promisify} from 'node:util';
    const seen=[];const lookup=new Promise(resolve=>dns.lookup('127.0.0.1',{all:true},(error,value)=>{seen.push('callback');resolve(value)}));seen.push('sync');
    console.log(JSON.stringify([seen.slice(),await lookup,seen,await promises.lookup('::1'),await promises.lookup('127.0.0.1',{family:6}),await promisify(dns.lookup)('192.0.2.1')]));`,
  'echo, half-close and server connection cleanup':`
    import net from 'node:net';
    const server=net.createServer({allowHalfOpen:true},socket=>{
      let text='';socket.setEncoding('utf8');socket.on('data',value=>text+=value);socket.on('end',()=>socket.end(text.toUpperCase()));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const client=net.connect(server.address().port,'127.0.0.1'),seen=[];client.setEncoding('utf8');
    client.on('data',value=>seen.push(value));const closed=new Promise((resolve,reject)=>{client.on('close',resolve);client.on('error',reject)});
    client.end('hello 🦊');await closed;await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify([seen.join(''),server.listening,server.address()]));`,
  'stream backpressure and byte counters':`
    import net from 'node:net';import {Buffer} from 'node:buffer';
    const server=net.createServer(socket=>socket.pipe(socket));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const client=net.connect(server.address().port,'127.0.0.1');let received=0,sum=0;client.on('data',bytes=>{received+=bytes.length;for(const byte of bytes)sum+=byte});
    const closed=new Promise((resolve,reject)=>{client.on('close',resolve);client.on('error',reject)});
    client.end(Buffer.alloc(256*1024,7));await closed;await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify([received,sum,client.bytesRead,client.bytesWritten]));`,
  'IP address classification':`
    import net from 'node:net';
    const inputs=['127.0.0.1','127.01.0.1','256.0.0.1','0.0.0.0','::','::1','::ffff:192.0.2.1','2001:db8::1','fe80::1%en0','1:2:3:4:5:6:7:8','1:2:3:4:5:6:7:8::',':::','localhost',''];
    console.log(JSON.stringify(inputs.map(input=>[net.isIP(input),net.isIPv4(input),net.isIPv6(input)])));`,
  'port collision reports an asynchronous error and does not close the original':`
    import net from 'node:net';
    const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const duplicate=net.createServer();const error=new Promise(resolve=>duplicate.on('error',error=>resolve(error.code)));
    duplicate.listen(server.address().port,'127.0.0.1');const code=await error;
    console.log(JSON.stringify([code,server.listening,duplicate.listening]));await new Promise(resolve=>server.close(resolve));`,
  'server callbacks retain their asynchronous local context':`
    import net from 'node:net';import {AsyncLocalStorage} from 'node:async_hooks';
    const als=new AsyncLocalStorage();let server,seen;
    await als.run('server',()=>new Promise(resolve=>{server=net.createServer(socket=>{seen=als.getStore();socket.end('ok')});server.listen(0,'127.0.0.1',resolve)}));
    const client=als.run('client',()=>net.connect(server.address().port,'127.0.0.1'));client.resume();await new Promise(resolve=>client.on('close',resolve));
    await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify([seen,als.getStore()]));`,
}
for(const [name,source] of Object.entries(cases))test(name,async({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,timeoutMs:10000})}finally{kernel.close()}
  },source)
  await info.attach('network.json',{body:JSON.stringify({node:node.stdout,nodeVersion:process.version,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(node.stdout)
})

test('repeated availability probes close listeners across local interface hosts',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`import net from 'node:net';import os from 'node:os';
      const hosts=new Set([undefined,'0.0.0.0']);for(const entries of Object.values(os.networkInterfaces()))for(const entry of entries)hosts.add(entry.address);
      const probe=host=>new Promise((resolve,reject)=>{const server=net.createServer();server.unref();server.on('error',reject);server.listen({port:8129,host},()=>server.close(()=>resolve(host??'default'))) });
      const seen=[];for(const host of hosts)try{seen.push(await probe(host))}catch(error){if(!['EADDRNOTAVAIL','EINVAL'].includes(error.code))throw error}console.log(JSON.stringify(seen));`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toContain('default')
})

test('host connects to a live guest server, other kernels cannot reach it',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`import net from 'node:net';const server=net.createServer(socket=>{socket.on('data',bytes=>socket.end('reply:'+bytes.toString()));socket.on('close',()=>server.close())});server.listen(8123,'127.0.0.1',()=>console.log('ready'));`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source}),other=new window.sandboxLab.WorkerKernel()
    let ready!:()=>void;const listening=new Promise<void>(resolve=>ready=resolve)
    try{
      const run=kernel.runModule('/main.mjs',{guestWasm:true,timeoutMs:5000,onOutput:(_level,text)=>{if(text.includes('ready'))ready()}})
      await listening
      let isolated='';try{await other.connect(8123)}catch(error){isolated=String(error)}
      const socket=await kernel.connect(8123)
      await socket.write(new TextEncoder().encode('hello'));await socket.end()
      let text=''
      for(;;){const event=await socket.read();if(event?.type==='data')text+=new TextDecoder().decode(event.bytes);else break}
      await socket.close()
      return {isolated,text,run:await run}
    }finally{kernel.close();other.close()}
  })
  expect(result.isolated).toContain('ECONNREFUSED');expect(result.text).toBe('reply:hello');expect(result.run.exitCode,result.run.stderr).toBe(0)
})

test('deadline releases server ports and unref permits execution to finish',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/hold.mjs':`import net from 'node:net';net.createServer().listen(8124);`,'/unref.mjs':`import net from 'node:net';net.createServer().listen(8124).unref();console.log('released')`})
    try{
      const deadline=await kernel.runModule('/hold.mjs',{timeoutMs:100})
      const recovery=await kernel.runModule('/unref.mjs')
      let released='';try{await kernel.connect(8124)}catch(error){released=String(error)}
      return {deadline,recovery,released}
    }finally{kernel.close()}
  })
  expect(result.deadline.exitCode).toBe(1);expect(result.deadline.stderr).toMatch(/timed out|interrupted/)
  expect(result.recovery.stdout).toBe('released\n');expect(result.recovery.exitCode,result.recovery.stderr).toBe(0);expect(result.released).toContain('ECONNREFUSED')
})

test('socket callback errors fail the command and permit a fresh server',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const files={'/bad.mjs':`import net from 'node:net';const server=net.createServer(()=>{throw Error('connection callback failed')});server.listen(8125,()=>net.connect(8125));`,
      '/good.mjs':`import net from 'node:net';net.createServer().listen(8125).unref();console.log('recovered')`}
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{return {failed:await kernel.runModule('/bad.mjs',{guestWasm:true,timeoutMs:1000}),recovered:await kernel.runModule('/good.mjs',{guestWasm:true})}}finally{kernel.close()}
  })
  expect(result.failed.exitCode).toBe(1);expect(result.failed.stderr).toContain('connection callback failed')
  expect(result.recovered.exitCode,result.recovered.stderr).toBe(0);expect(result.recovered.stdout).toBe('recovered\n')
})

test('guest network bridge bounds pending operations and queued write bytes',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`const net=globalThis.__webContainerHost.net;
      const server=net.call('listen',8126),reads=[];let readCode;
      for(let i=0;i<1000;i++){try{reads.push(net.next(server.id).catch(error=>error.code))}catch(error){readCode=error.code;break}}
      net.call('closeServer',server.id);await Promise.all(reads);
      const listener=net.call('listen',8126),client=net.call('connect',8126),writes=[];let writeCode;
      for(let i=0;i<32;i++){try{writes.push(net.write(client.id,new Uint8Array(65536)).catch(error=>error.code))}catch(error){writeCode=error.code;break}}
      net.call('destroy',client.id);await Promise.all(writes);
      console.log(JSON.stringify([reads.length,readCode,writes.length,writeCode]));net.call('ref',listener.id,false);
      const accepted=await net.next(listener.id);net.call('destroy',accepted.id);net.call('closeServer',listener.id);`
    const kernel=new window.sandboxLab.WorkerKernel({'/quota.mjs':source})
    try{return await kernel.runModule('/quota.mjs',{guestWasm:true,maxBytes:32*1024*1024,timeoutMs:10000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([512,'ERR_RESOURCE_LIMIT',16,'ERR_RESOURCE_LIMIT'])
})

test('guest socket binary writes preserve sliced bytes and reject oversized bridge chunks',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`import net from 'node:net';
      let accepted;const server=net.createServer(socket=>{accepted=socket;socket.pause()});
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8127,'127.0.0.1',resolve)});
      const client=net.connect(8127,'127.0.0.1');await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject)});
      while(!accepted)await new Promise(resolve=>setTimeout(resolve,0));
      const backing=new Uint8Array([9,9,0,127,128,255,9,9]),view=backing.subarray(2,6);
      await new Promise((resolve,reject)=>client.write(view,error=>error?reject(error):resolve()));
      backing.fill(42);client.end();
      const chunks=[];accepted.on('data',chunk=>chunks.push(...chunk));accepted.resume();
      await new Promise((resolve,reject)=>{accepted.once('end',resolve);accepted.once('error',reject)});
      accepted.end();await new Promise(resolve=>server.close(resolve));
      const raw=globalThis.__webContainerHost.net,listener=raw.call('listen',8128),rawClient=raw.call('connect',8128),connection=await raw.next(listener.id);
      let oversized;try{await raw.write(rawClient.id,new Uint8Array(65537));oversized='accepted'}catch(error){oversized=String(error)}
      raw.call('destroy',rawClient.id);raw.call('destroy',connection.id);raw.call('closeServer',listener.id);
      console.log(JSON.stringify({chunks,backing:[...backing],oversized}));`
    const kernel=new window.sandboxLab.WorkerKernel({'/binary-write.mjs':source})
    try{return await kernel.runModule('/binary-write.mjs',{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  const output=JSON.parse(result.stdout)
  expect(output.chunks).toEqual([0,127,128,255])
  expect(output.backing).toEqual(Array(8).fill(42))
  expect(output.oversized).toContain('Socket write exceeds transport limit')
})

test('virtual localhost lookup honors family and order without external DNS',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`import dns from 'node:dns/promises';import {AsyncLocalStorage} from 'node:async_hooks';const als=new AsyncLocalStorage();const values=[];values.push(await dns.lookup('localhost',{family:4}),await dns.lookup('localhost',{family:6}));dns.setDefaultResultOrder('ipv6first');values.push(await dns.lookup('LOCALHOST.',{all:true}));values.push(await als.run('lookup',async()=>{await dns.lookup('localhost');return als.getStore()}));try{await dns.lookup('example.com')}catch(error){values.push(error.code)}console.log(JSON.stringify(values));`
    const kernel=new window.sandboxLab.WorkerKernel({'/dns.mjs':source});try{return await kernel.runModule('/dns.mjs',{guestWasm:true})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([{address:'127.0.0.1',family:4},{address:'::1',family:6},[{address:'::1',family:6},{address:'127.0.0.1',family:4}],'lookup','EACCES'])
})
