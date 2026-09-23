import {test,expect} from '@playwright/test'

test('fiber kernel preserves worker file progress and parent callback order',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/main.mjs':`import {Worker} from 'node:worker_threads';import fs from 'node:fs';
const events=['before'];
const worker=new Worker(new URL('./worker.mjs',import.meta.url));
const message=new Promise((resolve,reject)=>{worker.on('message',resolve);worker.on('error',reject)});
const exited=new Promise(resolve=>worker.on('exit',resolve));
setTimeout(()=>{events.push('timer');Promise.resolve().then(()=>events.push('microtask'))},0);
let waits=0;while(!fs.existsSync('/child.txt')&&waits++<200)__qjsFiberWait(10);
if(!fs.existsSync('/child.txt'))throw Error('Child did not progress');
events.push('after');const text=fs.readFileSync('/child.txt','utf8');
const value=await message;await exited;
console.log(JSON.stringify({text,value,events,waited:waits>0}));`,
      '/worker.mjs':`import {parentPort} from 'node:worker_threads';import fs from 'node:fs';fs.writeFileSync('/child.txt','from child');parentPort.postMessage(42);`,
    },{experimentalFibers:true,timeoutMs:15000})
    try{return await kernel.runModule('/main.mjs',{writable:true,webAPIs:true,timeoutMs:15000})}
    finally{kernel.close()}
  })
  await info.attach('fiber-kernel-result.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({text:'from child',value:42,events:['before','after','timer','microtask'],waited:true})
})

test('default kernel does not expose experimental wait',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({})
    try{return await kernel.execute('console.log(typeof __qjsFiberWait)')}
    finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe('undefined\n')
})

test('cancelled parked process cleans up and shared engine remains usable',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/wait.mjs':"console.log('waiting');while(true)__qjsFiberWait(1000)"},{experimentalFibers:true,timeoutMs:10000})
    try{
      const task=await kernel.spawn('node',['/wait.mjs'],{timeoutMs:10000})
      const ready=await task.next()
      await task.kill('SIGKILL')
      const stopped=await task.wait();await task.dispose()
      const recovery=await kernel.execute('console.log(6*7)')
      return {ready,stopped,recovery,resources:await kernel.resources()}
    }finally{kernel.close()}
  })
  await info.attach('fiber-cancellation.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.ready?.type).toBe('stdout')
  expect(result.stopped.signal).toBe('SIGKILL')
  expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
  expect(result.recovery.stdout).toBe('42\n')
  expect(result.resources.processes).toEqual({active:0,retained:0})
  expect(result.resources.fileSessions).toBe(0)
})

test('parked bounded fiber reports one deadline interrupt and remains usable',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/deadline.mjs':"console.log('parking');__qjsFiberWait(1000);throw Error('wait did not expire')"},{experimentalFibers:true,timeoutMs:5000})
    try{
      const warm=await kernel.execute('console.log(1)',{timeoutMs:1000})
      const deadline=await kernel.runModule('/deadline.mjs',{timeoutMs:1000})
      const recovery=await kernel.execute('console.log(6*7)',{timeoutMs:1000})
      return {warm,deadline,recovery,interrupts:kernel.jobProfile.filter(row=>row.phase==='interrupt')}
    }finally{kernel.close()}
  })
  await info.attach('fiber-deadline.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.warm.exitCode,result.warm.stderr).toBe(0)
  expect(result.deadline.stdout).toBe('parking\n')
  expect(result.deadline.exitCode).toBe(1)
  expect(result.deadline.stderr).toMatch(/cancelled/i)
  expect(result.interrupts).toHaveLength(1)
  expect(result.interrupts[0]).toMatchObject({reason:'deadline',budget:{lifetime:'bounded',timeoutMs:1000}})
  expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
  expect(result.recovery.stdout).toBe('42\n')
})
