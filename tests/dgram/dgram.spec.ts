import {expect,test} from '@playwright/test'

for(const guestWasm of [false,true])test(`sandbox-local node:dgram ${guestWasm?'WASM':'default'}`,async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>Boolean(window.sandboxLab))
  const result=await page.evaluate(async guestWasm=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`import dgram from 'node:dgram';
      const server=dgram.createSocket('udp4'),client=dgram.createSocket('udp4');
      const done=new Promise((resolve,reject)=>{server.on('error',reject);client.on('error',reject);server.on('message',(message,rinfo)=>resolve([message.toString(),rinfo,server.address(),client.remoteAddress()]));});
      await new Promise(resolve=>server.bind(0,resolve));client.connect(server.address().port,'127.0.0.1',()=>client.send('packet'));console.log(JSON.stringify(await done));client.close();server.close();`})
    try{return {run:await kernel.execute('/main.mjs',{guestWasm}),resources:await kernel.resources()}}finally{kernel.close()}
  },guestWasm)
  expect(result.run.exitCode,result.run.stderr).toBe(0);expect(result.run.stdout).toContain('packet');expect(result.resources.datagrams).toEqual({handles:0,bound:0})
})
