import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'child output buffers own their bytes and preserve sliced writes':`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"const b=Buffer.from([99,0,255,128,42,99]);process.stdout.write(b.subarray(1,5));process.stderr.write(b.subarray(1,5));"]);
    const out=[],err=[];let buffers=true;
    child.stdout.on('data',chunk=>{buffers=buffers&&Buffer.isBuffer(chunk);out.push(...chunk);chunk.fill(7)});
    child.stderr.on('data',chunk=>{buffers=buffers&&Buffer.isBuffer(chunk);err.push(...chunk)});
    const code=await new Promise(resolve=>child.on('close',resolve));
    console.log(JSON.stringify({out,err,buffers,code}));`,
  'referenced message port keeps an unreferenced timer delivery alive':`
    import {MessageChannel} from 'node:worker_threads';
    const {port1,port2}=new MessageChannel();
    const result=new Promise(resolve=>port2.once('message',resolve));
    setTimeout(()=>port1.postMessage(42),30).unref();
    console.log(JSON.stringify(await result));port1.close();port2.close();`,
  'execArgv preserves eval flags separately from script arguments':`
    import {execFile} from 'node:child_process';
    const code="console.log(JSON.stringify([process.execArgv,process.argv.slice(1)]))";
    const values=[];
    for(const flags of [['-e'],['--input-type=module','--eval']]){
      const output=await new Promise((resolve,reject)=>execFile(process.execPath,[...flags,code,'hello'],(error,stdout)=>error?reject(error):resolve(stdout)));
      values.push(JSON.parse(output));
    }
    console.log(JSON.stringify(values));`,
  'promisified execFile returns both streams and the child handle':`
    import {execFile} from 'node:child_process';import {promisify} from 'node:util';
    const running=promisify(execFile)(process.execPath,['-e',"process.stdout.write('out');process.stderr.write('err')"]);const output=await running;
    console.log(JSON.stringify([output,typeof running.child.pid]));`,
  'missing executable emits error then close without spawn or exit':`
    import {spawn} from 'node:child_process';
    const child=spawn('/missing-command'),seen=[];child.on('spawn',()=>seen.push('spawn'));child.on('exit',()=>seen.push('exit'));child.on('error',error=>seen.push(error.code));await new Promise(resolve=>child.on('close',()=>{seen.push('close');resolve()}));console.log(JSON.stringify(seen));`,
  'execFile maxBuffer fails and preserves a bounded prefix':`
    import {execFile} from 'node:child_process';
    const output=await new Promise(resolve=>execFile(process.execPath,['-e',"process.stdout.write('abcdefghijk')"],{maxBuffer:4},(error,stdout)=>resolve([error.code,stdout])));console.log(JSON.stringify(output));`,
  'CommonJS eval, arguments, environment and exit status':`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"process.stdout.write(JSON.stringify([process.argv.slice(1),process.env.PROBE,typeof require('node:fs').readFileSync]));process.stderr.write('warning');process.exitCode=7",'hello'],{env:{PROBE:'child'}});
    let stdout='',stderr='';const events=[];child.on('spawn',()=>events.push('spawn'));child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
    child.on('exit',(code,signal)=>events.push(['exit',code,signal]));await new Promise(resolve=>child.on('close',(code,signal)=>{events.push(['close',code,signal]);resolve()}));
    console.log(JSON.stringify({stdout,stderr,events}));`,
  'binary stdin and independent stdout and stderr':`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"process.stdin.on('data',bytes=>{process.stdout.write(bytes);process.stderr.write(bytes)})"]);
    const out=[],err=[];child.stdout.on('data',bytes=>out.push(bytes));child.stderr.on('data',bytes=>err.push(bytes));
    const done=new Promise(resolve=>child.on('close',resolve));child.stdin.end(Buffer.from([0,255,128,65,240,159,166,138]));await done;
    console.log(JSON.stringify([Array.from(Buffer.concat(out)),Array.from(Buffer.concat(err))]));`,
  'stdin backpressure and large output drained while running':`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"process.stdin.pipe(process.stdout)"]);
    let count=0,sum=0;child.stdout.on('data',bytes=>{count+=bytes.length;for(const byte of bytes)sum+=byte});
    const done=new Promise(resolve=>child.on('close',resolve));child.stdin.end(Buffer.alloc(256*1024,7));await done;console.log(JSON.stringify([count,sum]));`,
  'execFile callback buffers both streams':`
    import {execFile} from 'node:child_process';
    const output=await new Promise(resolve=>execFile(process.execPath,['-e',"process.stdout.write('hello');process.stderr.write('error');process.exitCode=3"],(error,stdout,stderr)=>resolve([error.code,stdout,stderr])));
    console.log(JSON.stringify(output));`,
  'module eval and parent asynchronous context':`
    import {execFile} from 'node:child_process';import {AsyncLocalStorage} from 'node:async_hooks';
    const als=new AsyncLocalStorage();const output=await als.run('parent',()=>new Promise(resolve=>execFile(process.execPath,['--input-type=module','-e',"import {AsyncLocalStorage} from 'node:async_hooks';await Promise.resolve();console.log(JSON.stringify([new AsyncLocalStorage().getStore(),typeof require]))"],(error,stdout)=>resolve([error?.code??null,stdout,als.getStore()]))));
    console.log(JSON.stringify(output));`,
  'concurrent children keep their globals and environments separate':`
    import {execFile} from 'node:child_process';
    const run=value=>new Promise(resolve=>execFile(process.execPath,['-e',"globalThis.test=process.env.VALUE;setTimeout(()=>console.log(globalThis.test),5)"],{env:{VALUE:value}},(error,stdout)=>resolve([error?.code??null,stdout.trim()])));
    console.log(JSON.stringify([await Promise.all([run('a'),run('b')]),typeof globalThis.test]));`,
  'kill a waiting child after startup':`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"console.log('ready');setInterval(()=>{},1000)"]);
    let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);child.stdout.once('data',()=>child.kill('SIGTERM'));const output=await new Promise(resolve=>child.on('close',(code,signal)=>resolve([code,signal,child.killed,stderr])));console.log(JSON.stringify(output));`,
  'exit and close expose final state in order':`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e',"process.stdout.write('done');process.exitCode=6"]),events=[];child.on('exit',(code,signal)=>events.push(['exit',code,signal,child.exitCode,child.signalCode]));child.on('close',(code,signal)=>events.push(['close',code,signal,child.exitCode,child.signalCode]));child.unref().ref();await new Promise(resolve=>child.once('close',resolve));console.log(JSON.stringify([events,child.kill()]));`,
  'signal zero probes and lowercase SIGINT terminates':`
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);const probe=child.kill(0),before=[child.killed,child.exitCode,child.signalCode],stopped=child.kill('sigint');const closed=await new Promise(resolve=>child.on('close',(code,signal)=>resolve([code,signal])));console.log(JSON.stringify([probe,before,stopped,closed]));`,
  'pre-aborted child reports abort between spawn and exit':`
    import {spawn} from 'node:child_process';
    const controller=new AbortController();controller.abort('cancelled');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal}),events=[];child.on('spawn',()=>events.push('spawn'));child.on('error',error=>events.push([error.code,error.cause]));child.on('exit',()=>events.push('exit'));await new Promise(resolve=>child.once('close',resolve));events.push('close');console.log(JSON.stringify(events));`,
}
for(const guestWasm of [false,true])for(const [name,source] of Object.entries(cases))test(`${guestWasm?'WASM bridge':'default engine'}: ${name}`,async({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },{source,guestWasm})
  await info.attach('process.json',{body:JSON.stringify({node:node.stdout,nodeVersion:process.version,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(node.stdout)
})

test('host stdin, executable files, shared workspace and concurrent commands',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/server.mjs':`import readline from 'node:readline';import fs from 'node:fs';const lines=readline.createInterface({input:process.stdin});for await(const line of lines){fs.writeFileSync('/answer',line);console.log('saved:'+line)}`})
    try{
      const child=await kernel.spawn('node',['/server.mjs'],{guestWasm:true})
      await child.write('hello\n');const saved=await child.next()
      const concurrent=await kernel.execute(`console.log('other command')`)
      const text=await kernel.readText('/answer');await child.end();const done=await child.wait();await child.dispose()
      return {saved,text,concurrent,done}
    }finally{kernel.close()}
  })
  expect(result.saved?.type).toBe('stdout');expect(result.text).toBe('hello')
  expect(result.concurrent.exitCode,result.concurrent.stderr).toBe(0);expect(result.concurrent.stdout).toBe('other command\n')
  expect(result.done.exitCode,result.done.stderr).toBe(0)
})

test('children inherit read-only authority and cannot execute host commands',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`import {execFile} from 'node:child_process';const output=await new Promise(resolve=>execFile(process.execPath,['-e',"try{require('node:fs').writeFileSync('/forbidden','no');console.log('WRITTEN')}catch(error){console.log(error.message)}"],(error,stdout)=>resolve([error?.code??null,stdout])));console.log(JSON.stringify(output))`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{
      const run=await kernel.runModule('/main.mjs',{writable:false,guestWasm:true,timeoutMs:10000})
      let denied='';try{await kernel.spawn('/bin/sh',['-c','echo unsafe'])}catch(error){denied=String(error)}
      return {run,denied,files:(await kernel.snapshot()).files}
    }finally{kernel.close()}
  })
  expect(result.run.exitCode,result.run.stderr).toBe(0);expect(result.run.stdout).not.toContain('WRITTEN');expect(result.run.stdout).toMatch(/denied|read.only|EACCES/i)
  expect(result.denied).toContain('ENOENT');expect(result.files).not.toHaveProperty('/forbidden')
})

test('parent and child connect through virtual sockets',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`import net from 'node:net';import {execFile} from 'node:child_process';const server=net.createServer(socket=>socket.end('shared network'));await new Promise(resolve=>server.listen(8130,resolve));const text=await new Promise(resolve=>execFile(process.execPath,['-e',"const socket=require('node:net').connect(8130);socket.pipe(process.stdout)"],(error,stdout)=>resolve([error?.code??null,stdout])));await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(text));`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual([null,'shared network'])
})

test('child exceptions reach stderr and a new command still runs',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`import {execFile} from 'node:child_process';const output=await new Promise(resolve=>execFile(process.execPath,['-e',"throw Error('deliberate child failure')"],(error,stdout,stderr)=>resolve([error.code,stdout,stderr.includes('deliberate child failure')])));console.log(JSON.stringify(output));`})
    try{return {failed:await kernel.runModule('/main.mjs',{guestWasm:true}),recovery:await kernel.execute('console.log(42)')}}finally{kernel.close()}
  })
  expect(result.failed.exitCode,result.failed.stderr).toBe(0);expect(JSON.parse(result.failed.stdout)).toEqual([1,'',true]);expect(result.recovery.stdout).toBe('42\n');expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
})

test('cancelling the parent stops descendants and releases their server ports',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',"require('node:net').createServer().listen(8131,()=>console.log('ready'))"]);child.stdout.pipe(process.stdout);`})
    try{
      const parent=await kernel.spawn('node',['/main.mjs'],{guestWasm:true});await parent.next();await parent.kill();const stopped=await parent.wait();await parent.dispose()
      const recovery=await kernel.execute(`const server=globalThis.__webContainerHost.net.call('listen',8131);console.log('reclaimed');globalThis.__webContainerHost.net.call('closeServer',server.id)`)
      return {stopped,recovery}
    }finally{kernel.close()}
  })
  expect(result.stopped.exitCode).toBe(1);expect(result.recovery.exitCode,result.recovery.stderr).toBe(0);expect(result.recovery.stdout).toBe('reclaimed\n')
})

test('raw guest process calls cannot raise permissions or read another owner',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`const proc=globalThis.__webContainerHost.proc;const child=proc.call('spawn','node',['-e',"try{require('node:fs').writeFileSync('/forbidden','no');console.log('WRITTEN')}catch(error){console.log(error.message)}"],{writable:true});let text='';for(;;){const event=await proc.next(child);if(event.type==='exit')break;if(event.type==='stdout')text+=String.fromCharCode(...new Uint8Array(event.bytes))}proc.call('forget',child);let denied;try{await proc.next(process.pid)}catch(error){denied=error.code}console.log(JSON.stringify([text,denied]));`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{writable:false,guestWasm:true})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0);const [text,denied]=JSON.parse(result.stdout)
  expect(text).toMatch(/denied|read.only|EACCES/i);expect(text).not.toContain('WRITTEN');expect(denied).toBe('ESRCH')
})

test('host cancellation and output quota recover without discarding the workspace',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/keep':'saved'})
    try{
      const flood=await kernel.spawn('node',['-e',`for(let i=0;i<80;i++)process.stdout.write(Buffer.alloc(16384,7))`],{guestWasm:true})
      const failed=await flood.wait();await flood.dispose()
      const waiting=await kernel.spawn('node',['-e',`setInterval(()=>{},1000)`],{guestWasm:true});await waiting.kill();const stopped=await waiting.wait();await waiting.dispose();await waiting.dispose()
      return {failed,stopped,text:await kernel.readText('/keep'),recovery:await kernel.execute('console.log(42)')}
    }finally{kernel.close()}
  })
  expect(result.failed.exitCode).toBe(1);expect(result.failed.stderr).toMatch(/quota|queue/i)
  expect(result.stopped.exitCode).toBe(1);expect(result.stopped.signal).toBe('SIGTERM');expect(result.text).toBe('saved');expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
})

test('a child cancelled before startup cannot change the shared workspace',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync('/cancelled-write','unexpected')"]);child.kill('SIGKILL');await new Promise(resolve=>child.on('close',resolve));console.log(JSON.stringify([child.signalCode,fs.existsSync('/cancelled-write')]));`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual(['SIGKILL',false])
})
