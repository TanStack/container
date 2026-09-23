import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
const cooperative=process.env.TERMINATION_COOPERATIVE==='1'

for(const start of [false,true])test(`exit from WASM ${start?'start function':'callback'}`,async({page})=>{
  const bytes=[...readFileSync(`public/guest-wasm/${start?'callback-start':'callback'}.wasm`)]
  const source=`try{const m=new WebAssembly.Module(new Uint8Array(${JSON.stringify(bytes)}));const i=new WebAssembly.Instance(m,{host:{${start?'start':'callback'}:()=>process.exit(27)}});${start?'':'i.exports.call(1);'}console.log('after')}catch(e){console.log('caught')}finally{console.log('finally')}`
  const expected=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async ({source,cooperative})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/exit.mjs':source},{cooperative})
    try{
      const run=await kernel.runModule('/exit.mjs',{guestWasm:true})
      const recovery=await kernel.execute('console.log(42)',{guestWasm:true})
      return {run,recovery}
    }finally{kernel.close()}
  },{source,cooperative})
  expect(result.run.exitCode,result.run.stderr).toBe(expected.status)
  expect(result.run.stdout).toBe(expected.stdout)
  expect(result.run.stderr).toBe(expected.stderr)
  expect(result.recovery.stdout).toBe('42\n')
})

const cases={
  'synchronous exit skips handlers':`try{process.exit(7)}catch(e){console.log('caught')}finally{console.log('finally')}console.log('after')`,
  'async prefix stops its caller':`(async()=>process.exit(8))();console.log('after')`,
  'promise exit stops queued jobs':`Promise.resolve().then(()=>process.exit(9));Promise.resolve().then(()=>console.log('after'));`,
  'async exit skips rejection handlers':`(async()=>{await 0;try{process.exit(10)}finally{console.log('finally')}})().catch(()=>console.log('caught'));`,
  'exit emits once and uses the chosen status':`process.exitCode=11;process.on('exit',code=>console.log('exit:'+code));process.exit();`,
  'timer exit cancels remaining work':`setTimeout(()=>process.exit(12),0);setTimeout(()=>console.log('after'),100);`,
}
for(const guestWasm of [false,true])for(const [name,source] of Object.entries(cases))test(`${guestWasm?'WASM':'JS'}: ${name}`,async({page})=>{
  await page.goto('/sandbox.html')
  const expected=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'})
  const result=await page.evaluate(async ({source,guestWasm,cooperative})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source},{cooperative})
    try{
      const run=await kernel.runModule('/main.mjs',{timeoutMs:5000,guestWasm})
      const recovery=await kernel.execute('6*7',{guestWasm})
      return {run,recovery}
    }finally{kernel.close()}
  },{source,guestWasm,cooperative})
  expect(result.run.exitCode,result.run.stderr).toBe(expected.status)
  expect(result.run.stdout).toBe(expected.stdout)
  expect(result.run.stderr).toBe(expected.stderr)
  expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
})

test('exit releases parent and descendant server ports',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async(cooperative)=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/parent.mjs':`import {createServer} from 'node:net';import {spawn} from 'node:child_process';await new Promise(resolve=>createServer().listen(8140,resolve));const child=spawn(process.execPath,['/child.mjs']);await new Promise(resolve=>child.stdout.once('data',resolve));process.exit(23);`,
      '/child.mjs':`import {createServer} from 'node:net';createServer().listen(8141,()=>console.log('ready'));`,
      '/check.mjs':`import {createServer} from 'node:net';for(const port of [8140,8141]){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,()=>server.close(resolve))})}console.log('recovered');`,
    },{cooperative})
    try{
      const run=await kernel.runModule('/parent.mjs',{guestWasm:true,timeoutMs:10000})
      const recovery=await kernel.runModule('/check.mjs',{guestWasm:true,timeoutMs:10000})
      return {run,recovery}
    }finally{kernel.close()}
  },cooperative)
  expect(result.run.exitCode,result.run.stderr).toBe(23)
  expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
  expect(result.recovery.stdout).toBe('recovered\n')
})

test('shell pipefail uses native process exit and broken pipe status',async({page})=>{
  await page.goto('/sandbox.html')
  const codes=await page.evaluate(async(cooperative)=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/input':''},{cooperative})
    try{
      const codes=[]
      for(const script of [
        `node -e 'process.exit(7)' | node -e 'process.exit(0)'`,
        `set -o pipefail; node -e 'process.exit(7)' | node -e 'process.exit(0)'`,
        `set -o pipefail; node -e 'process.stdout.write(Buffer.alloc(262144,65))' | node -e 'process.exit(0)'`,
      ])codes.push((await window.sandboxLab.runMvdanShell(kernel,script,{timeoutMs:10000})).code)
      return codes
    }finally{kernel.close()}
  },cooperative)
  expect(codes).toEqual([0,7,141])
})
