import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const files=Object.fromEntries(['parent','middle','leaf','state'].map(name=>{
 const filename=`nested-worker-${name}.mjs`;return ['/'+filename,readFileSync('tests/fixtures/'+filename,'utf8')]
}))
for(const guestWasm of [false,true])test(`nested workers isolate state and route streams and ports ${guestWasm?'WASM':'default'}`,async({page})=>{
 const native=spawnSync(process.execPath,['tests/fixtures/nested-worker-parent.mjs'],{encoding:'utf8',timeout:15000})
 expect(native.status,native.stderr).toBe(0)
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async({files,guestWasm})=>{
  const kernel=new window.sandboxLab.WorkerKernel(files)
  try{return await kernel.runModule('/nested-worker-parent.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
 },{files,guestWasm})
 expect(result.exitCode,result.stderr).toBe(0)
 expect(JSON.parse(result.stdout)).toEqual(JSON.parse(native.stdout))
})
test('terminating an owner process stops nested workers and permits immediate restart',async({page})=>{
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async()=>{
  const leaf=`const {parentPort}=require('node:worker_threads');parentPort.postMessage('ready');setInterval(()=>{},1000);`
  const middle=`const {Worker,parentPort}=require('node:worker_threads');const worker=new Worker(${JSON.stringify(leaf)},{eval:true,execArgv:['--input-type=commonjs']});worker.on('message',()=>parentPort.postMessage('ready'));`
  const main=`import {Worker} from 'node:worker_threads';const worker=new Worker(${JSON.stringify(middle)},{eval:true,execArgv:['--input-type=commonjs']});worker.on('message',()=>console.log('ready'));`
  const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':main,'/restart.mjs':'console.log(42)'})
  const child=await kernel.spawn('node',['/main.mjs'],{webAPIs:true,timeoutMs:15000})
  try{
   for(;;){const event=await child.next();if(!event||event.type==='exit')throw Error('Nested workers exited before ready');if(event.type==='stdout'&&new TextDecoder().decode(event.bytes).includes('ready'))break}
   await child.kill();const stopped=await child.wait();await child.dispose()
   const restarted=await kernel.runModule('/restart.mjs',{webAPIs:true,timeoutMs:5000})
   return {stopped,restarted}
  }finally{kernel.close()}
 })
 expect(result.stopped.signal).toBe('SIGTERM')
 expect(result.restarted.exitCode,result.restarted.stderr).toBe(0);expect(result.restarted.stdout.trim()).toBe('42')
})
