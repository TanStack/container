import {test,expect} from '@playwright/test'
import {mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'URL formatting options':`
    import {format} from 'node:url';
    const url=new URL('https://user:p%40ss@example.com/a?x=1#h');
    console.log(JSON.stringify([format(url),format(url,{auth:false}),format(url,{fragment:false}),format(url,{search:false}),format('https://example.com/a')]));`,
  'utilities, custom promisify, and assertions':`
    import util from 'node:util';import assert from 'node:assert/strict';
    const object={value:3,add(n,callback){callback(null,this.value+n)}};
    const add=util.promisify(object.add);const custom=function(){};
    custom[Symbol.for('nodejs.util.promisify.custom')]=async()=>42;
    const seen=[await add.call(object,4),await util.promisify(custom)(),util.promisify.custom===Symbol.for('nodejs.util.promisify.custom'),util.promisify(add)===add];
    seen.push(util.format('%s %d %j','hello',3,{x:7}),util.isDeepStrictEqual(new Map([['x',{a:1}]]),new Map([['x',{a:1}]])));
    const circular={};circular.self=circular;assert.deepEqual(circular,circular);
    assert.throws(()=>assert.equal(1,'1'),{code:'ERR_ASSERTION'});
    await assert.rejects(Promise.reject(Error('expected')),/expected/);
    seen.push(await new Promise(resolve=>util.callbackify(async function(){return this.value}).call(object,(error,value)=>resolve([error===null,value]))));
    console.log(JSON.stringify(seen));`,
  'hashes, HMAC, sliced views, and Buffer identity':`
    import {createHash,createHmac,hash} from 'node:crypto';import {Buffer} from 'node:buffer';
    const input=new Uint8Array([99,1,2,3,88]),view=new DataView(input.buffer,1,3);
    const values=['md5','sha1','sha224','sha256','sha384','sha512','ripemd160'].map(algorithm=>[
      createHash(algorithm).update('hello ').update('🦊').digest('hex'),createHmac(algorithm,'secret').update(view).digest('hex')]);
    const digest=createHash('sha256').update(input.subarray(1,4)).digest();
    values.push([digest instanceof Buffer,Buffer===globalThis.Buffer,digest.toString('hex'),hash('sha256','hello'),hash('sha256','hello','buffer') instanceof Buffer]);
    console.log(JSON.stringify(values));`,
  'random API shape, callback context, and ranges':`
    import crypto from 'node:crypto';import {Buffer} from 'node:buffer';import {AsyncLocalStorage} from 'node:async_hooks';
    const als=new AsyncLocalStorage(),bytes=crypto.randomBytes(32),array=new Uint8Array(12).fill(7),view=array.subarray(2,10);
    const returned=crypto.randomFillSync(view,2,4);
    const values=[bytes instanceof Buffer,bytes.length,returned===view,Array.from(array.subarray(0,4)),Array.from(array.subarray(8)),/^.{8}-.{4}-4.{3}-[89ab].{3}-.{12}$/.test(crypto.randomUUID())];
    values.push(await als.run('random',()=>new Promise(resolve=>crypto.randomBytes(8,(error,value)=>resolve([error===null,value.length,als.getStore()])))));
    values.push(Array.from({length:20},()=>crypto.randomInt(-3,7)).every(n=>Number.isInteger(n)&&n>=-3&&n<7));
    const ints=new Uint16Array(3);values.push(crypto.getRandomValues(ints)===ints);
    console.log(JSON.stringify(values));`,
  'user timing marks, measures, clone, and cleanup':`
    import {performance} from 'node:perf_hooks';
    const detail={value:3};performance.mark('start',{startTime:3,detail});detail.value=7;
    performance.mark('end',{startTime:9});performance.measure('duration','start','end');
    performance.measure('explicit',{start:2,duration:5,detail:{ok:true}});
    const values=performance.getEntries().map(entry=>entry.toJSON());
    performance.clearMarks();performance.clearMeasures('duration');
    console.log(JSON.stringify([values,performance.getEntriesByType('mark').length,performance.getEntriesByName('explicit').length]));`,
  'performance observer delivery and monotonic clocks':`
    import {performance,PerformanceObserver} from 'node:perf_hooks';import process from 'node:process';
    const records=await new Promise(resolve=>{const observer=new PerformanceObserver(list=>{observer.disconnect();resolve(list.getEntries().map(x=>[x.name,x.entryType,x.startTime,x.duration]))});observer.observe({entryTypes:['mark','measure']});performance.mark('sample',{startTime:7});performance.measure('span',{start:3,end:7});});
    const before=process.hrtime(),big=process.hrtime.bigint(),now=performance.now();await new Promise(r=>setTimeout(r,3));
    const delta=process.hrtime(before);
    console.log(JSON.stringify([records,delta[0]>=0,delta[1]>=0&&delta[1]<1e9,process.hrtime.bigint()>big,performance.now()>=now,process.uptime()>=0,Number.isFinite(performance.timeOrigin)]));`,
  'callback filesystem and promisified operations':`
    import fs from 'node:fs';import {promisify} from 'node:util';import {Buffer} from 'node:buffer';import {AsyncLocalStorage} from 'node:async_hooks';
    const root=globalThis.__fixtureRoot??'',path=root+'/value.txt',als=new AsyncLocalStorage();
    await promisify(fs.writeFile)(path,'hello');
    const value=await promisify(fs.readFile)(path),stat=await promisify(fs.stat)(path),lstat=await promisify(fs.lstat)(path);
    await promisify(fs.access)(path,fs.constants.R_OK);
    const missing=await als.run('filesystem',()=>new Promise(resolve=>fs.stat(root+'/missing',(error)=>resolve([error.code,als.getStore()]))));
    console.log(JSON.stringify([value instanceof Buffer,value.toString(),stat.isFile(),stat.size,lstat.isDirectory(),missing,(await promisify(fs.realpath)(path))===path]));`,
  'performance observer async context':`
    import {AsyncLocalStorage} from 'node:async_hooks';import {performance,PerformanceObserver} from 'node:perf_hooks';
    const als=new AsyncLocalStorage();let observer,finish;const done=new Promise(resolve=>finish=resolve);
    als.run('created',()=>{observer=new PerformanceObserver(()=>{observer.disconnect();finish(als.getStore())})});
    als.run('observed',()=>observer.observe({entryTypes:['mark']}));
    als.run('marked',()=>performance.mark('context'));
    console.log(JSON.stringify(await done));`,
  'performance delivery batches share first-event context':`
    import {AsyncLocalStorage} from 'node:async_hooks';import {performance,PerformanceObserver} from 'node:perf_hooks';
    const als=new AsyncLocalStorage(),seen=[];let finish;const done=new Promise(resolve=>finish=resolve);
    for(const type of ['mark','measure']){const observer=new PerformanceObserver(list=>{seen.push([type,als.getStore(),list.getEntries().length]);observer.disconnect();if(seen.length===2)finish()});observer.observe({entryTypes:[type]})}
    als.run('first',()=>performance.mark('one',{startTime:1}));await 0;
    als.run('second',()=>{performance.mark('two',{startTime:2});performance.measure('span',{start:1,end:2})});
    await done;console.log(JSON.stringify(seen));`,
}
for(const [name,code] of Object.entries(cases))for(const execution of ['modules','bundle'] as const)test('Node core | '+execution+' | '+name,async({page},info)=>{
  const directory=info.outputPath('reference');mkdirSync(directory,{recursive:true})
  const node=spawnSync(process.execPath,['--input-type=module'],{input:'globalThis.__fixtureRoot='+JSON.stringify(directory)+';\n'+code,encoding:'utf8',timeout:10000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({code,execution})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':code})
    try{return await (execution==='modules'?kernel.runModule('/entry.mjs',{webAPIs:true}):kernel.run('/entry.mjs',{webAPIs:true}))}finally{kernel.close()}
  },{code,execution})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(node.stdout)
})

for(const execution of ['modules','bundle'] as const)test('Node core | '+execution+' default runtime, entropy quota, callback authority, and recovery',async({page})=>{
  await page.goto('/sandbox.html')
  const report=await page.evaluate(async execution=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':`
      import {randomBytes,createHash} from 'node:crypto';import fs from 'node:fs';
      const seen=[createHash('sha256').update('hello').digest('hex')];
      for(let i=0;i<4;i++)randomBytes(1024*1024);
      try{randomBytes(1)}catch(error){seen.push(error.code)}
      seen.push(await new Promise(resolve=>fs.writeFile('/denied','value',error=>resolve(error.code))));
      console.log(JSON.stringify(seen));`})
    const settings={writable:false,maxBytes:64*1024*1024,timeoutMs:8000};
    try{return {result:await (execution==='modules'?kernel.runModule('/entry.mjs',settings):kernel.run('/entry.mjs',settings)),files:Object.keys((await kernel.snapshot()).files),recovery:await kernel.execute('console.log(42)')}}finally{kernel.close()}
  },execution)
  expect(report.result.exitCode,report.result.stderr).toBe(0)
  expect(JSON.parse(report.result.stdout)).toEqual(['2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824','ERR_RESOURCE_LIMIT','EACCES'])
  expect(report.files).not.toContain('/denied')
  expect(report.recovery.exitCode).toBe(0)
})

test('Node core | virtual process policy and resource limits',async({page})=>{
  await page.goto('/sandbox.html')
  const report=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/file':'value','/policy.mjs':`
      import process from 'node:process';import os from 'node:os';import {Worker,isMainThread,threadId,parentPort} from 'node:worker_threads';import {performance} from 'node:perf_hooks';import fs from 'node:fs';import {randomBytes} from 'node:crypto';
      const seen=[process===globalThis.process,os.platform(),os.arch(),os.availableParallelism(),os.cpus(),isMainThread,threadId,parentPort];
      for(const operation of [()=>fs.accessSync('/file',fs.constants.W_OK),()=>randomBytes(1024*1024+1)]){try{operation();seen.push('unexpected')}catch(error){seen.push(error.code)}}
      for(let i=0;i<1024;i++)performance.mark('mark',{startTime:i});
      try{performance.mark('overflow')}catch(error){seen.push(error.code)}
      console.log(JSON.stringify(seen));`})
    try{return {result:await kernel.runModule('/policy.mjs',{webAPIs:true,writable:false}),recovery:await kernel.execute('console.log(42)')}}finally{kernel.close()}
  })
  expect(report.result.exitCode,report.result.stderr).toBe(0)
  expect(JSON.parse(report.result.stdout)).toEqual([true,'browser','wasm32',1,[{model:'Virtual CPU',speed:0,times:{user:0,nice:0,sys:0,idle:0,irq:0}}],true,0,null,'EACCES','ERR_OUT_OF_RANGE','ERR_RESOURCE_LIMIT'])
  expect(report.recovery.exitCode).toBe(0)
})
