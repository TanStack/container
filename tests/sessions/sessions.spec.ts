import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

for(const guestWasm of [false,true]){
  test(`${guestWasm?'WASM bridge':'default engine'}: an idle server survives its CPU and host RPC deadlines`,async({page},info)=>{
    test.setTimeout(60000)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async guestWasm=>{
      const kernel=new window.sandboxLab.WorkerKernel({
        '/message':'first',
        '/server.mjs':`import http from 'node:http';import fs from 'node:fs';const server=http.createServer((req,res)=>res.end(fs.readFileSync('/message','utf8')));server.listen(8295,()=>console.log('ready'));`,
      },{timeoutMs:1000})
      try{
        const server=await kernel.spawn('node',['/server.mjs'],{lifetime:'session',timeoutMs:1000,guestWasm})
        const ready=await server.next()
        // Keep wait() pending beyond the old 31-second owner RPC watchdog.
        const waiting=server.wait()
        const request=async()=>{
          const socket=await kernel.connect(8295)
          try{
            await socket.write(new TextEncoder().encode('GET / HTTP/1.1\r\nHost: preview\r\nConnection: close\r\n\r\n'))
            let text='';for(;;){const event=await socket.read();if(event?.type!=='data')break;text+=new TextDecoder().decode(event.bytes)}
            return text
          }finally{await socket.close()}
        }
        const first=await request()
        await new Promise(resolve=>setTimeout(resolve,32500))
        await kernel.writeText('/message','edited after idle')
        const other=await kernel.execute('console.log(42)',{timeoutMs:1000})
        const edited=await request()
        await server.kill();const stopped=await waiting;await server.dispose()
        const restarted=await kernel.spawn('node',['/server.mjs'],{lifetime:'session',timeoutMs:1000,guestWasm})
        const restartedReady=await restarted.next();const again=await request();await restarted.dispose()
        return {ready,first,edited,again,other,stopped,restartedReady}
      }finally{kernel.close()}
    },guestWasm)
    await info.attach('session.json',{body:JSON.stringify(result),contentType:'application/json'})
    expect(result.ready?.type).toBe('stdout');expect(result.restartedReady?.type).toBe('stdout')
    expect(result.first).toContain('first');expect(result.edited).toContain('edited after idle');expect(result.again).toContain('edited after idle')
    expect(result.other.exitCode,result.other.stderr).toBe(0);expect(result.other.stdout).toBe('42\n')
    expect(result.stopped.signal).toBe('SIGTERM')
  })

  for(const [name,code] of Object.entries({
    'synchronous loop':'for(;;){}',
    'promise chain':'await new Promise(()=>{const spin=()=>{Promise.resolve().then(spin)};spin()})',
    'timer callback':'await new Promise(resolve=>setTimeout(resolve,1200));for(;;){}',
  }))test(`${guestWasm?'WASM bridge':'default engine'}: session interrupts a ${name} and recovers`,async({page})=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({guestWasm,code})=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/keep':'preserved'})
      try{
        const child=await kernel.spawn('node',['--input-type=module','-e',code],{lifetime:'session',timeoutMs:1000,guestWasm})
        const failed=await child.wait();await child.dispose()
        return {failed,recovery:await kernel.execute('console.log(42)'),file:await kernel.readText('/keep')}
      }finally{kernel.close()}
    },{guestWasm,code})
    expect(result.failed.exitCode).toBe(1);expect(result.failed.stderr).toMatch(/interrupted|timed out/)
    expect(result.recovery.exitCode,result.recovery.stderr).toBe(0);expect(result.recovery.stdout).toBe('42\n');expect(result.file).toBe('preserved')
  })

  test(`${guestWasm?'WASM bridge':'default engine'}: an unsettled top-level await exits without waiting forever`,async({page})=>{
    const source='await new Promise(()=>{})'
    const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:5000})
    expect(node.status).toBe(13)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({source,guestWasm})=>{
      const kernel=new window.sandboxLab.WorkerKernel()
      try{
        const child=await kernel.spawn('node',['--input-type=module','-e',source],{lifetime:'session',guestWasm})
        const stopped=await child.wait();await child.dispose();return stopped
      }finally{kernel.close()}
    },{source,guestWasm})
    expect(result.exitCode,result.stderr).toBe(node.status);expect(result.stderr).toContain('Unsettled top-level await')
  })

  test(`${guestWasm?'WASM bridge':'default engine'}: allocation pressure cannot leave a session stuck`,async({page})=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async guestWasm=>{
      const kernel=new window.sandboxLab.WorkerKernel()
      try{
        const child=await kernel.spawn('node',['--input-type=module','-e','await new Promise(()=>{const spin=()=>Promise.resolve().then(spin);spin()})'],{lifetime:'session',timeoutMs:1000,guestWasm})
        const failed=await child.wait();await child.dispose();return {failed,recovery:await kernel.execute('console.log(42)')}
      }finally{kernel.close()}
    },guestWasm)
    expect(result.failed.exitCode).not.toBe(0);expect(result.failed.stderr).toMatch(/Unsettled|memory|interrupted|timed out/)
    expect(result.recovery.exitCode,result.recovery.stderr).toBe(0);expect(result.recovery.stdout).toBe('42\n')
  })
}

test('bounded commands still time out while idle and cannot grant session lifetime to a child',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{
      const child=await kernel.spawn('node',['-e','setInterval(()=>{},10000)'],{timeoutMs:1000})
      const failed=await child.wait();await child.dispose()
      const authority=await kernel.execute(`try{__webContainerHost.proc.call('spawn','node',['-e','setInterval(()=>{},1000)'],{lifetime:'session'});console.log('ESCALATED')}catch(error){console.log(error.message)}`)
      let direct='';try{await kernel.execute('console.log(1)',{lifetime:'session'} as any)}catch(error){direct=String(error)}
      return {failed,authority,direct}
    }finally{kernel.close()}
  })
  expect(result.failed.exitCode).toBe(1);expect(result.failed.stderr).toMatch(/timed out|interrupted/)
  expect(result.authority.stdout).toContain('cannot create a session');expect(result.authority.stdout).not.toContain('ESCALATED')
  expect(result.direct).toContain('requires spawn')
})

test('session children inherit lifetime and cancellation releases descendant listeners',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/parent.mjs':`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',"require('node:net').createServer(socket=>socket.end('child alive')).listen(8296,()=>console.log('ready'))"]);child.stdout.pipe(process.stdout);`})
    try{
      const parent=await kernel.spawn('node',['/parent.mjs'],{lifetime:'session',timeoutMs:1000,guestWasm:true})
      const ready=await parent.next();await new Promise(resolve=>setTimeout(resolve,1500))
      const socket=await kernel.connect(8296);const event=await socket.read();await socket.close()
      await parent.dispose()
      const recovery=await kernel.execute(`const net=__webContainerHost.net;const server=net.call('listen',8296);console.log('reclaimed');net.call('closeServer',server.id)`)
      return {ready,event,recovery}
    }finally{kernel.close()}
  })
  expect(result.ready?.type).toBe('stdout');expect(result.event?.type).toBe('data')
  if(result.event?.type==='data')expect(new TextDecoder().decode(Uint8Array.from(result.event.bytes))).toBe('child alive')
  expect(result.recovery.exitCode,result.recovery.stderr).toBe(0);expect(result.recovery.stdout).toBe('reclaimed\n')
})
