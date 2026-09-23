import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

const webSource=readFileSync('public/vm-web-apis/globals.js','utf8')

test('process bootstrap preserves early references and listeners',async({page})=>{
  await page.route('**/vm-web-apis/globals.js',route=>route.fulfill({contentType:'text/javascript',body:webSource+`
    globalThis.__earlyProcess=process;globalThis.__earlyEnv=process.env;globalThis.__earlyEvents=[];
    process.on('owner-check',value=>__earlyEvents.push(value));
  `}))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const source=`import process from 'node:process';import {EventEmitter} from 'node:events';import assert from 'node:assert/strict';
      assert.equal(process,globalThis.__earlyProcess);assert.equal(process.env,globalThis.__earlyEnv);
      assert.ok(process instanceof EventEmitter);process.emit('owner-check',17);
      assert.deepEqual(globalThis.__earlyEvents,[17]);assert.equal(process.cwd(),'/project');
      await new Promise(resolve=>process.nextTick(resolve));console.log('same process');`
    const kernel=new window.sandboxLab.WorkerKernel({'/project/main.mjs':source})
    try{return await kernel.runModule('/project/main.mjs',{cwd:'/project',webAPIs:true})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('same process\n')
})

test('Web API bundle loaded after Node retains process, streams and output',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async webSource=>{
    const source=`import process from 'node:process';import fs from 'node:fs';import {Readable} from 'node:stream';import assert from 'node:assert/strict';
      const original=process,output=process.stdout,environment=process.env;
      let events=0;process.on('owner-check',()=>events++);
      (0,eval)(fs.readFileSync('/web-apis.js','utf8'));
      assert.equal(globalThis.process,original);assert.equal(process.stdout,output);assert.equal(process.env,environment);
      assert.equal(Readable,globalThis[Symbol.for('web-container:node-stream')].Readable);
      process.emit('owner-check');assert.equal(events,1);
      assert.equal(await new Response('body').text(),'body');
      await new Promise(resolve=>{const input=Readable.from(['a']);input.on('end',resolve);input.pipe(process.stdout)});
      assert.equal(process.stdout.writableEnded,false);console.log('b');`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source,'/web-apis.js':webSource},{maxBytes:64*1024*1024})
    try{return await kernel.runModule('/main.mjs',{webAPIs:false,maxBytes:64*1024*1024,timeoutMs:30000})}finally{kernel.close()}
  },webSource)
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('ab\n')
})

test('standalone Web APIs work without installing the Node facade',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{return await kernel.execute(`(async()=>{
      await new Promise(resolve=>process.nextTick(resolve));
      const request=new Request('https://example.invalid/',{method:'POST',body:'hello'});
      const response=new Response(await request.text());
      console.log(JSON.stringify([await response.text(),typeof process.stdout,typeof process.on]));
    })()`,{webAPIs:true})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('["hello","undefined","function"]\n')
})

for(const webAPIs of [false,true])test('shared process state stays local to each command: Web APIs '+webAPIs,async({page},info)=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async webAPIs=>{
    const source=`import process from 'node:process';import assert from 'node:assert/strict';
      assert.equal(process.marker,undefined);assert.equal(process.env.PROBE_MARKER,undefined);
      assert.equal(process.listenerCount('owner-check'),0);
      process.marker=process.pid;process.env.PROBE_MARKER=String(process.pid);
      process.on('owner-check',()=>{});
      await new Promise(resolve=>setTimeout(resolve,2));
      assert.equal(process.marker,process.pid);assert.equal(process.env.PROBE_MARKER,String(process.pid));
      assert.equal(process.listenerCount('owner-check'),1);console.log(process.pid);`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    const run=()=>kernel.runModule('/main.mjs',{webAPIs})
    const spawn=async()=>{
      const child=await kernel.spawn('node',['/main.mjs'],{webAPIs})
      try{return await child.wait()}finally{await child.dispose()}
    }
    // runModule is intentionally single-flight; spawn owns concurrent commands.
    try{return [await run(),await run(),...await Promise.all([spawn(),spawn()])]}finally{kernel.close()}
  },webAPIs)
  await info.attach('process-command-isolation.json',{body:JSON.stringify(results),contentType:'application/json'})
  for(const result of results)expect(result.exitCode,result.stderr).toBe(0)
  expect(new Set(results.map(result=>result.stdout.trim())).size).toBe(4)
})
