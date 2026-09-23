import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

const files=Object.fromEntries(['parent','child'].map(name=>['/ipc-'+name+'.mjs',readFileSync('tests/fixtures/ipc-'+name+'.mjs','utf8')]))
test('kernel IPC bridge transports owned bytes and disconnects',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/parent.mjs':`const p=globalThis.__webContainerHost.proc;
        const child=p.call('fork','node',['/child.mjs'],{},'json');
        p.call('ipcSend',child,[0,255,42]);
        const reply=await p.ipcNext(child);console.log(JSON.stringify(reply));
        await p.ipcNext(child);console.log(p.call('ipcConnected',child));
        while(await p.next(child)){ }p.call('forget',child);`,
      '/child.mjs':`const p=globalThis.__webContainerHost.proc;
        const bytes=await p.ipcNext(process.pid);p.call('ipcSend',process.pid,bytes);
        p.call('ipcDisconnect',process.pid);`,
    })
    try{return await kernel.runModule('/parent.mjs',{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('[0,255,42]\nfalse\n')
})
for(const guestWasm of [false,true])test(`fork IPC round trip ${guestWasm?'WASM':'default'}`,async({page},info)=>{
  const node=spawnSync(process.execPath,['tests/fixtures/ipc-parent.mjs'],{encoding:'utf8',timeout:15000})
  expect(node.status,node.stderr).toBe(0)
  expect(JSON.parse(node.stdout)).toEqual({code:0,signal:null,disconnected:true,replies:[{kind:'ready'},{kind:'reply',value:42,bytes:[0,255],bigint:'123',connected:true}],callbacks:['sender']})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{return await kernel.runModule('/ipc-parent.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },{files,guestWasm})
  await info.attach('ipc.json',{body:JSON.stringify({node:node.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(node.stdout))
})
