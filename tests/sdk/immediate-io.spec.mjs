import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'

const root=realpathSync(process.env.SDK_OUTPUT)
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'))
let server,url
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

const workerCode=`const {parentPort}=require('node:worker_threads');parentPort.on('message',value=>parentPort.postMessage(value));`;
const source=`const {Worker}=require('node:worker_threads');const evidence={received:0,immediates:0,maxPending:0,firstImmediateAt:null};const workers=[];let pending=0;
(async()=>{try{await Promise.all(Array.from({length:4},(_,lane)=>new Promise((resolve,reject)=>{const worker=new Worker(${JSON.stringify(workerCode)},{eval:true,execArgv:['--input-type=commonjs']});workers.push(worker);worker.on('error',reject);worker.on('message',value=>{evidence.received++;pending++;evidence.maxPending=Math.max(evidence.maxPending,pending);setImmediate(()=>{pending--;evidence.immediates++;if(evidence.firstImmediateAt===null)evidence.firstImmediateAt=evidence.received});if(value<39)worker.postMessage(value+1);else resolve()});worker.postMessage(0)})));await new Promise(resolve=>setImmediate(resolve));}catch(error){evidence.failure={name:error.name,message:error.message}}finally{for(const worker of workers)await worker.terminate()}console.log(JSON.stringify(evidence));process.exit(evidence.failure?1:0)})();`;
const completionDuringCompute=`const {Worker}=require('node:worker_threads');const events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);
const worker=new Worker("const {workerData,parentPort}=require('node:worker_threads');parentPort.postMessage(42);const view=new Int32Array(workerData);Atomics.store(view,0,1);Atomics.notify(view,0);",{eval:true,execArgv:['--input-type=commonjs'],workerData:buffer});
const message=new Promise((resolve,reject)=>{worker.on('error',reject);worker.once('message',value=>{events.push('message:'+value);resolve()})});
(async()=>{try{if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('worker did not send');events.push('compute-start');let answer=0;for(let i=0;i<1000000;i++)answer=(answer+i%97)%1000000007;events.push('compute-end:'+answer);Promise.resolve().then(()=>events.push('microtask'));await message;console.log(JSON.stringify(events));}finally{await worker.terminate()}})().catch(error=>{console.error(error);process.exitCode=1});`;
const cleanupAfterMicrotasks=`const {Worker}=require('node:worker_threads');const events=[];
const worker=new Worker("const {parentPort}=require('node:worker_threads');parentPort.postMessage('trigger');parentPort.postMessage('cleanup');",{eval:true,execArgv:['--input-type=commonjs']});
worker.on('error',error=>{console.error(error);process.exitCode=1});worker.on('message',value=>{events.push(value);if(value==='trigger'){process.nextTick(()=>events.push('nextTick'));let chain=Promise.resolve();for(let i=0;i<200;i++)chain=chain.then(()=>{if(i===50||i===150)events.push('work:'+i)});chain.then(()=>events.push('microtasks-done'))}else{console.log(JSON.stringify(events));worker.terminate()}});`;
const cases=[{name:'async filesystem callback follows current microtasks',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const fs=require('node:fs'),events=[];fs.stat('.',error=>{if(error)throw error;events.push('callback');setImmediate(()=>console.log(JSON.stringify(events)))});queueMicrotask(()=>events.push('microtask'));`},{name:'queued worker cleanup waits for the prior message microtasks',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:cleanupAfterMicrotasks},{name:'pending worker completion preserves compute and microtask ordering',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:completionDuringCompute},{name:'finite worker I/O and immediate interleaving',maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source},
 {name:'check cancellation microtasks and newly scheduled callbacks',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const events=[];let cancelled;setImmediate(()=>{events.push('first');clearImmediate(cancelled);Promise.resolve().then(()=>events.push('microtask'));setImmediate(()=>{events.push('new');console.log(JSON.stringify(events))})});cancelled=setImmediate(()=>events.push('cancelled'));setImmediate(()=>events.push('last-existing'));`},
 {name:'microtask cancels the next check callback',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const events=[];let cancelled;setImmediate(()=>{events.push('first');Promise.resolve().then(()=>{events.push('microtask');clearImmediate(cancelled)})});cancelled=setImmediate(()=>events.push('cancelled'));setImmediate(()=>{events.push('last');console.log(JSON.stringify(events))});`}
];

cases.push({name:'async filesystem errors preserve task ordering and ALS',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const fs=require('node:fs'),{AsyncLocalStorage}=require('node:async_hooks'),als=new AsyncLocalStorage(),events=[];als.run('file-context',()=>{fs.stat('./missing-ordering-fixture',error=>{events.push('callback:'+error.code+':'+als.getStore());console.log(JSON.stringify(events))});queueMicrotask(()=>events.push('microtask:'+als.getStore()))});`});
cases.push({name:'promise filesystem completion follows finite microtask chain',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const fs=require('node:fs/promises'),events=[];const result=fs.stat('./missing-ordering-fixture').catch(error=>events.push('file:'+error.code));let chain=Promise.resolve();for(let i=0;i<40;i++)chain=chain.then(()=>{if(i===39)events.push('microtasks-done')});Promise.all([result,chain]).then(()=>console.log(JSON.stringify(events)));`});
cases.push({name:'FileHandle stat completion follows finite microtask chain',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const fs=require('node:fs/promises');(async()=>{const handle=await fs.open('.','r'),events=[];try{const result=handle.stat().then(stat=>events.push('stat:'+stat.isDirectory()));let chain=Promise.resolve();for(let i=0;i<40;i++)chain=chain.then(()=>{if(i===39)events.push('microtasks-done')});await Promise.all([result,chain]);console.log(JSON.stringify(events))}finally{await handle.close()}})().catch(error=>{console.error(error);process.exitCode=1});`});
cases.push({name:'already queued worker messages precede check callbacks',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const {Worker}=require('node:worker_threads'),events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage('trigger');parentPort.postMessage('cleanup');const view=new Int32Array(workerData);Atomics.store(view,0,1);Atomics.notify(view,0)",{eval:true,execArgv:['--input-type=commonjs'],workerData:buffer});let gotCleanup,gotImmediate;const cleanup=new Promise(r=>gotCleanup=r),immediate=new Promise(r=>gotImmediate=r);worker.on('message',value=>{events.push(value);if(value==='trigger')setImmediate(()=>{events.push('immediate');gotImmediate()});else gotCleanup()});worker.on('error',error=>{console.error(error);process.exitCode=1});if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('worker did not queue messages');Promise.all([cleanup,immediate]).then(async()=>{await worker.terminate();console.log(JSON.stringify(events))});`});

cases.push({name:'queued worker messages keep microtasks between callbacks',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const {Worker}=require('node:worker_threads'),events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads');for(let i=0;i<3;i++)parentPort.postMessage(i);const view=new Int32Array(workerData);Atomics.store(view,0,1);Atomics.notify(view,0)",{eval:true,execArgv:['--input-type=commonjs'],workerData:buffer});let received,checked;const messages=new Promise(r=>received=r),check=new Promise(r=>checked=r);worker.on('message',value=>{events.push('message:'+value);queueMicrotask(()=>events.push('microtask:'+value));if(value===0)setImmediate(()=>{events.push('immediate');checked()});if(value===2)received()});worker.on('error',error=>{console.error(error);process.exitCode=1});if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('worker did not queue messages');Promise.all([messages,check]).then(async()=>{await worker.terminate();console.log(JSON.stringify(events))});`});

cases.push({name:'worker reply during check waits for existing check callbacks',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const {Worker}=require('node:worker_threads'),events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);let checked,cleaned;const check=new Promise(resolve=>checked=resolve),cleanup=new Promise(resolve=>cleaned=resolve);
const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads'),view=new Int32Array(workerData);parentPort.on('message',()=>{parentPort.postMessage('cleanup');Atomics.store(view,0,1);Atomics.notify(view,0)});parentPort.postMessage('ready')",{eval:true,execArgv:['--input-type=commonjs'],workerData:buffer});
worker.on('error',error=>{console.error(error);process.exitCode=1});worker.on('message',value=>{if(value==='ready'){setImmediate(()=>{events.push('first');worker.postMessage('work');if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('worker did not reply');queueMicrotask(()=>events.push('microtask'))});setImmediate(()=>{events.push('second');checked()})}else{events.push(value);cleaned()}});Promise.all([check,cleanup]).then(async()=>{await worker.terminate();console.log(JSON.stringify(events))});`});

cases.push({name:'worker reply queued during poll precedes check callbacks',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`const {Worker}=require('node:worker_threads'),events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);let checked,cleaned;const check=new Promise(resolve=>checked=resolve),cleanup=new Promise(resolve=>cleaned=resolve);
const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads'),view=new Int32Array(workerData);parentPort.on('message',()=>{parentPort.postMessage('cleanup');Atomics.store(view,0,1);Atomics.notify(view,0)});parentPort.postMessage('ready')",{eval:true,execArgv:['--input-type=commonjs'],workerData:buffer});
worker.on('error',error=>{console.error(error);process.exitCode=1});worker.on('message',value=>{if(value==='ready'){events.push('ready');worker.postMessage('work');if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('worker did not reply');queueMicrotask(()=>events.push('microtask'));setImmediate(()=>{events.push('immediate');checked()})}else{events.push(value);cleaned()}});Promise.all([check,cleanup]).then(async()=>{await worker.terminate();console.log(JSON.stringify(events))});`});

cases.push({name:'mixed filesystem completion and active worker poll',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const fs=require('node:fs'),{Worker}=require('node:worker_threads'),events=[];
const buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);
let fileDone,messageDone,checkDone;
const file=new Promise(r=>fileDone=r),message=new Promise(r=>messageDone=r),check=new Promise(r=>checkDone=r);
const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads'),view=new Int32Array(workerData);parentPort.on('message',()=>{parentPort.postMessage('reply');Atomics.store(view,0,1);Atomics.notify(view,0)});parentPort.postMessage('ready')",{eval:true,execArgv:['--input-type=commonjs'],workerData:buffer});
worker.on('error',error=>{console.error(error);process.exitCode=1});
worker.on('message',value=>{
 events.push(value);
 if(value==='ready'){
  fs.stat('.',error=>{if(error)throw error;events.push('file');queueMicrotask(()=>{events.push('file-microtask');fileDone()})});
  worker.postMessage('work');
  if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('worker did not reply');
  queueMicrotask(()=>events.push('message-microtask'));
  setImmediate(()=>{events.push('immediate');checkDone()});
 }else messageDone();
});
Promise.all([file,message,check]).then(async()=>{
 await worker.terminate();
 console.log('MIXED_TRACE:'+JSON.stringify(events));
 // Filesystem completion versus worker delivery is a race, not a fixed order.
 console.log(JSON.stringify({workerOrder:events.filter(value=>!value.startsWith('file')),fileAfterMessageMicrotask:events.indexOf('file')>events.indexOf('message-microtask'),fileMicrotaskAfterCallback:events.indexOf('file-microtask')>events.indexOf('file'),fileCallbacks:events.filter(value=>value==='file').length}));
});`});

cases.push({name:'two ready worker ports drain their queued messages in port batches',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const {Worker}=require('node:worker_threads'),events=[],workers=[],buffer=new SharedArrayBuffer(8),view=new Int32Array(buffer);
let finish;const complete=new Promise(resolve=>finish=resolve);
for(let lane=0;lane<2;lane++){
 const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads');const {lane,buffer}=workerData;for(let i=0;i<3;i++)parentPort.postMessage({lane,i});const view=new Int32Array(buffer);Atomics.store(view,lane,1);Atomics.notify(view,lane);",{eval:true,execArgv:['--input-type=commonjs'],workerData:{lane,buffer}});
 workers.push(worker);worker.on('error',error=>{console.error(error);process.exitCode=1});
 worker.on('message',value=>{events.push(value);if(events.length===6)finish()});
}
for(let lane=0;lane<2;lane++)if(Atomics.wait(view,lane,0,5000)==='timed-out')throw Error('worker did not queue messages');
complete.then(async()=>{for(const worker of workers)await worker.terminate();const first=events[0].lane;console.log(JSON.stringify(events.map(value=>(value.lane===first?'first':'second')+':'+value.i)))});
`});

cases.push({name:'cleanup queued during check competes with newly scheduled check work',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const {Worker}=require('node:worker_threads'),events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);
let cleaned,checked;const cleanup=new Promise(r=>cleaned=r),check=new Promise(r=>checked=r);
const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads');parentPort.on('message',()=>{parentPort.postMessage('cleanup');const view=new Int32Array(workerData);Atomics.store(view,0,1);Atomics.notify(view,0)});parentPort.postMessage('ready')",{eval:true,execArgv:['--input-type=commonjs'],workerData:buffer});
worker.on('error',error=>{console.error(error);process.exitCode=1});
worker.on('message',value=>{if(value==='ready')setImmediate(()=>{
 events.push('first-check');worker.postMessage('work');
 if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('worker did not queue cleanup');
 queueMicrotask(()=>events.push('check-microtask'));
 setImmediate(()=>{events.push('next-check');checked()});
});else{events.push(value);cleaned()}});
Promise.all([cleanup,check]).then(async()=>{await worker.terminate();console.log(JSON.stringify(events))});
`});

cases.push({name:'second worker port becomes ready during first port callback',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const {Worker}=require('node:worker_threads'),events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);
const options={eval:true,execArgv:['--input-type=commonjs'],workerData:buffer};
const first=new Worker("const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>parentPort.postMessage('trigger'));parentPort.postMessage('ready')",options);
const second=new Worker("const {parentPort,workerData}=require('node:worker_threads');parentPort.on('message',()=>{parentPort.postMessage('cleanup');const view=new Int32Array(workerData);Atomics.store(view,0,1);Atomics.notify(view,0)});parentPort.postMessage('ready')",options);
let ready=0,cleaned,checked;const cleanup=new Promise(r=>cleaned=r),check=new Promise(r=>checked=r);
const onReady=()=>{if(++ready===2)first.postMessage('go')};
for(const worker of [first,second])worker.on('error',error=>{console.error(error);process.exitCode=1});
second.on('message',value=>{if(value==='ready')onReady();else{events.push(value);cleaned()}});
first.on('message',value=>{if(value==='ready'){onReady();return}events.push(value);second.postMessage('work');if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('second port did not queue cleanup');queueMicrotask(()=>events.push('microtask'));setImmediate(()=>{events.push('check');checked()})});
Promise.all([cleanup,check]).then(async()=>{await first.terminate();await second.terminate();console.log(JSON.stringify(events))});
`});

cases.push({name:'new worker port created during poll preserves native check ordering',ordering:true,nativeRepeats:10,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const {Worker}=require('node:worker_threads'),events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);
const options={eval:true,execArgv:['--input-type=commonjs'],workerData:buffer};
const first=new Worker("const {parentPort}=require('node:worker_threads');parentPort.postMessage('trigger')",options);
let second,cleaned,checked;const cleanup=new Promise(r=>cleaned=r),check=new Promise(r=>checked=r);
const failed=error=>{console.error(error);process.exitCode=1};first.on('error',failed);
first.once('message',value=>{
 events.push(value);
 second=new Worker("const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage('cleanup');const view=new Int32Array(workerData);Atomics.store(view,0,1);Atomics.notify(view,0)",options);
 second.on('error',failed);second.once('message',value=>{events.push(value);cleaned()});
 if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('new port did not queue cleanup');
 queueMicrotask(()=>events.push('microtask'));setImmediate(()=>{events.push('check');checked()});
});
Promise.all([cleanup,check]).then(async()=>{await first.terminate();await second.terminate();console.log(JSON.stringify(events))});
`});

cases.push({name:'promise reaction creates worker between existing check callbacks',ordering:true,nativeRepeats:10,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const {Worker}=require('node:worker_threads'),events=[],buffer=new SharedArrayBuffer(4),view=new Int32Array(buffer);
let release,child,cleaned,nested;const gate=new Promise(r=>release=r),cleanup=new Promise(r=>cleaned=r),next=new Promise(r=>nested=r);
gate.then(()=>{
 events.push('reaction');
 child=new Worker("const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage('cleanup');const view=new Int32Array(workerData);Atomics.store(view,0,1);Atomics.notify(view,0)",{eval:true,execArgv:['--input-type=commonjs'],workerData:buffer});
 child.on('error',error=>{console.error(error);process.exitCode=1});child.on('message',value=>{events.push(value);cleaned()});
 if(Atomics.wait(view,0,0,5000)==='timed-out')throw Error('new worker did not queue cleanup');
 setImmediate(()=>{events.push('nested');nested()});queueMicrotask(()=>events.push('reaction-microtask'));
});
setImmediate(()=>{events.push('first');release()});setImmediate(()=>events.push('sibling'));
Promise.all([cleanup,next]).then(async()=>{await child.terminate();console.log(JSON.stringify(events))});
`});

cases.push({name:'worker filename validation throws before launch',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const {Worker}=require('node:worker_threads');
(async()=>{const results=[];for(const filename of [42,null,{},'child.js','']){
 let worker;try{worker=new Worker(filename);worker.on('error',()=>{});results.push({threw:false})}
 catch(error){results.push({threw:true,name:error.name,code:error.code})}
 finally{if(worker)await worker.terminate()}
}console.log(JSON.stringify(results))})().catch(error=>{console.error(error);process.exitCode=1});
`});

cases.push({name:'nextTick priority and nested promise scheduling match Node',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const results={};
const run=(name,schedule)=>new Promise(resolve=>setImmediate(()=>{
 const events=[];schedule(events);setImmediate(()=>{results[name]=events;resolve()});
}));
(async()=>{
 await run('promise-before-tick',events=>{Promise.resolve().then(()=>events.push('promise'));process.nextTick(()=>events.push('tick'))});
 await run('nested-tick',events=>{process.nextTick(()=>{events.push('tick1');Promise.resolve().then(()=>events.push('promise-in-tick'));process.nextTick(()=>events.push('tick2'))});Promise.resolve().then(()=>events.push('promise'))});
 await run('tick-in-promise',events=>{Promise.resolve().then(()=>{events.push('promise1');process.nextTick(()=>events.push('tick'));Promise.resolve().then(()=>events.push('promise2'))})});
 console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exitCode=1});
`});

for(const boundary of ['timer','filesystem','worker'])cases.push({name:'nextTick callback boundary '+boundary,ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const {AsyncLocalStorage}=require('node:async_hooks'),als=new AsyncLocalStorage(),events=[];
let worker;
function callback(){
 events.push('callback:'+als.getStore());
 Promise.resolve().then(()=>events.push('promise:'+als.getStore()));
 als.run('tick-context',()=>process.nextTick((a,b)=>{
  events.push('tick:'+a+':'+b+':'+als.getStore());
  process.nextTick(()=>events.push('nested-tick:'+als.getStore()));
  Promise.resolve().then(()=>events.push('tick-promise:'+als.getStore()));
 },'arg',42));
 let chain=Promise.resolve();
 for(let i=0;i<240;i++)chain=chain.then(()=>{
  if(i===110){events.push('middle:'+als.getStore());process.nextTick(()=>events.push('microtask-tick:'+als.getStore()))}
  if(i===239)events.push('microtasks-done:'+als.getStore());
 });
 setImmediate(async()=>{if(worker)await worker.terminate();console.log(JSON.stringify(events))});
}
als.run('callback-context',()=>{
 ${boundary==='timer'?'setTimeout(callback,0)':boundary==='filesystem'?"require('node:fs').stat('.',error=>{if(error)throw error;callback()})":"const {Worker}=require('node:worker_threads');worker=new Worker(\"require('node:worker_threads').parentPort.postMessage('ready')\",{eval:true,execArgv:['--input-type=commonjs']});worker.on('error',error=>{throw error});worker.once('message',callback)"};
});
`});

for(const format of ['commonjs','module'])cases.push({name:'nextTick startup '+format,format,ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
${format==='module'?"import process from 'node:process';":"const process=require('node:process');"}
const events=[];
Promise.resolve().then(()=>{events.push('promise');process.nextTick(()=>events.push('promise-tick'))});
process.nextTick(()=>{events.push('tick');Promise.resolve().then(()=>events.push('tick-promise'))});
queueMicrotask(()=>events.push('microtask'));
setImmediate(()=>console.log(JSON.stringify(events)));
`});

cases.push({name:'nextTick startup microtasks finish before timer admission',format:'module',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
import process from 'node:process';const rows=[];
process.nextTick(()=>rows.push('tick'));
let chain=Promise.resolve();for(let i=0;i<240;i++)chain=chain.then(()=>{if(i===239)rows.push('microtasks')});
await new Promise(resolve=>setTimeout(resolve,0));console.log(JSON.stringify(rows));
`});

for(const channel of ['stdout','stderr'])cases.push({name:'nextTick child process '+channel+' callback priority',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const {spawn}=require('node:child_process'),events=[];
const child=spawn(process.execPath,['-e',"process.${channel}.write('hello')"]);
child.on('error',error=>{throw error});
child.${channel}.once('data',data=>{
 events.push('data:'+data.toString());
 Promise.resolve().then(()=>events.push('promise'));
 process.nextTick(()=>{events.push('tick');process.nextTick(()=>events.push('nested-tick'))});
 setImmediate(()=>console.log(JSON.stringify(events)));
});
`});

cases.push({name:'nextTick child process exit callback priority',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const {spawn}=require('node:child_process'),events=[];
const child=spawn(process.execPath,['-e','process.exit(0)']);
child.on('error',error=>{throw error});
child.on('exit',(code,signal)=>{
 events.push('exit:'+code+':'+signal);
 Promise.resolve().then(()=>events.push('promise'));
 process.nextTick(()=>{events.push('tick');process.nextTick(()=>events.push('nested-tick'))});
 setImmediate(()=>console.log(JSON.stringify(events)));
});
`});

cases.push({name:'nextTick filesystem watcher callback priority',ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
fs.mkdirSync(os.tmpdir(),{recursive:true});
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-tick-watch-'));
const file=path.join(directory,'fixture.txt');fs.writeFileSync(file,'before');
const events=[];let handled=false;
const watcher=fs.watch(file,()=>{
 if(handled)return;handled=true;events.push('change');
 Promise.resolve().then(()=>events.push('promise'));
 process.nextTick(()=>{events.push('tick');process.nextTick(()=>events.push('nested-tick'))});
 setImmediate(()=>{watcher.close();fs.unlinkSync(file);fs.rmdirSync(directory);console.log(JSON.stringify(events))});
});
watcher.on('error',error=>{throw error});setImmediate(()=>fs.writeFileSync(file,'after'));
`});

cases.push({name:'nextTick does not run after an uncaught callback error',expectedExitCode:1,ordering:true,maxBytes:64*1024*1024,workerMaxBytes:16*1024*1024,source:`
setImmediate(()=>{
 process.nextTick(()=>console.log(JSON.stringify(['tick-after-throw'])));
 console.log(JSON.stringify(['callback']));
 throw Error('expected callback fixture error');
});
`});

for(const sample of cases)test(`packaged worker ${'scheduling'}: ${sample.name}`,async({page},info)=>{
  test.skip(!manifest.buildProfile.startsWith('experimental-fibers'),'Requires fiber package')
  test.setTimeout(60000)
  const nativeArgs=[...(sample.format==='module'?['--input-type=module']:[]),'-e',sample.source]
  const native=spawnSync(process.execPath,nativeArgs,{encoding:'utf8',timeout:15000})
  expect(native.status,native.stderr||native.error?.message).toBe(sample.expectedExitCode??0)
  const nativeResult=JSON.parse(native.stdout.trim().split('\n').at(-1))
  const nativeRepeats=[nativeResult]
  for(let repeat=1;repeat<(sample.nativeRepeats??1);repeat++){
    const control=spawnSync(process.execPath,nativeArgs,{encoding:'utf8',timeout:15000})
    expect(control.status,control.stderr||control.error?.message).toBe(sample.expectedExitCode??0)
    nativeRepeats.push(JSON.parse(control.stdout.trim().split('\n').at(-1)))
  }
  for(const control of nativeRepeats)expect(control).toEqual(nativeResult)
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const diagnostics=process.env.IMMEDIATE_DIAGNOSTICS==='1'
  const observed=await page.evaluate(async({sample,diagnostics})=>{
    const entry=sample.format==='module'?'/project/main.mjs':'/project/main.cjs'
    const kernel=new window.sdk.WorkerKernel({[entry]:sample.source},{experimentalFibers:true,maxBytes:sample.maxBytes,workerMaxBytes:sample.workerMaxBytes,timeoutMs:15000})
    const output=[],samples=[];let result,error,closeError
    const pending=[]
    try{result=await kernel.runModule(entry,{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:sample.maxBytes,timeoutMs:15000,...(diagnostics?{diagnostics:true}:{}),onOutput:(level,text)=>{output.push({level,text});if(text.includes('phase:first-started'))pending.push(kernel.resources().then(value=>samples.push(value)).catch(error=>samples.push({error:error.message})))}});await Promise.all(pending);samples.push(await kernel.resources())}
    catch(cause){error={name:cause.name,message:cause.message}}
    finally{try{kernel.close()}catch(cause){closeError={message:cause.message}}}
    return {result,error,closeError,output,samples,...(diagnostics?{jobProfile:kernel.jobProfile}:{})}
  },{sample,diagnostics})
  const path=info.outputPath('immediate-io.json')
  await writeFile(path,JSON.stringify({sdk:root,profile:manifest.buildProfile,sample,native:{status:native.status,stdout:native.stdout,stderr:native.stderr,result:nativeResult,repeats:nativeRepeats},observed},null,2))
  await info.attach('immediate-io.json',{path,contentType:'application/json'})
  expect(observed.error,JSON.stringify(observed)).toBeUndefined()
  expect(observed.result.exitCode,observed.result.stderr).toBe(sample.expectedExitCode??0)
  const result=JSON.parse(observed.result.stdout.trim().split('\n').at(-1))
  if(sample.ordering){expect(result).toEqual(nativeResult);if(Array.isArray(result))expect(result).not.toContain('cancelled')}
  else for(const value of [nativeResult,result]){expect(value.failure).toBeUndefined();expect(value.received).toBe(160);expect(value.immediates).toBe(160);expect(value.maxPending).toBeLessThan(128);expect(value.firstImmediateAt).toBeLessThan(160)}
  expect(observed.closeError).toBeUndefined()
  if(diagnostics&&sample.name==='check cancellation microtasks and newly scheduled callbacks')expect(observed.jobProfile.some(row=>row.phase==='scheduler-check-batches'&&row.checkBatches.length>0)).toBe(true)
  if(diagnostics)for(const summary of observed.jobProfile.filter(row=>row.phase==='scheduler-check-batches')){
    expect(summary.checkBatches.length).toBeLessThanOrEqual(64)
    expect(summary.dropped).toBe(summary.jobs-summary.checkBatches.length)
    for(const batch of summary.checkBatches){
      expect(batch.queued.total).toBe(batch.completions)
      expect(Object.values(batch.sources).reduce((sum,count)=>sum+count,0)).toBe(batch.completions)
      expect(batch.ports).toHaveLength(batch.queued.workers.length)
      expect(batch.ports.map(port=>port.endpoint)).toEqual(batch.queued.workers.map(worker=>worker.endpoint))
      expect(batch.queued.throughBoundary).toBe(0)
      expect(batch.queued.workers.length).toBeLessThanOrEqual(32)
      expect(batch.queued.workerEndpoints-batch.queued.workers.length).toBe(batch.queued.truncated)
      if(batch.queued.truncated===0)expect(batch.queued.workers.reduce((sum,worker)=>sum+worker.pending,0)+batch.queued.nonWorker).toBe(batch.queued.total)
      expect(batch.dispatched+batch.cancelled).toBeLessThanOrEqual(batch.callbacks)
      if(batch.endAt!==undefined){expect(batch.dispatched+batch.cancelled).toBe(batch.callbacks);expect(batch.endAt).toBeGreaterThanOrEqual(batch.at)}
    }
  }
})
