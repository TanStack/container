import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/project/'+name,readFileSync('fixtures/install-vitest/'+name,'utf8')]))
const asyncEmitterSource=readFileSync('tests/fixtures/async-emitter.mjs','utf8')
for(const phase of ['cpu-kill','kill','cancel','watch','repair','serialization','memory','discovery','async-emitter','ports','console','import','run'])test(`installed Vitest ${phase}`,async({page,context},info)=>{
  const cooperative=process.env.COOPERATIVE_KERNEL==='1'
  if(cooperative&&process.env.ATOMICS_CANDIDATE==='1')await context.route(/\/quickjs-als-asyncify(?:-wasm)?-cooperative\//,route=>{
    return route.continue({url:route.request().url().replace('-cooperative/','-atomics-cooperative/')})
  })
  if(process.env.ATOMICS_CANDIDATE==='1')await context.route(/\/quickjs-als(?:-wasm)?\//,route=>{
    const url=route.request().url().replace(/\/quickjs-als(-wasm)?\//,(_match,wasm)=>'/quickjs-als'+(wasm??'')+'-atomics/')
    return route.continue({url})
  })
  await page.goto('/sandbox.html')
  const processMiB=Number(process.env.VITEST_PROCESS_MIB??256)
  if(![64,128,256].includes(processMiB))throw Error('Expected VITEST_PROCESS_MIB=64, 128 or 256')
  const result=await page.evaluate(async({files,phase,asyncEmitterSource,traceIPC,processMiB,cooperative})=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{cooperative,maxBytes:processMiB*1024*1024,workspace:{maxBytes:128*1024*1024}})
    let stage='install'
    try{
      const installation=await kernel.install({cwd:'/project',ignoreScripts:true})
      await kernel.writeText('/project/math.ts',phase==='repair'?'export const add=(a:number,b:number)=>a-b':'export const add=(a:number,b:number)=>a+b')
      await kernel.writeText('/project/math.test.ts','import {test,expect} from "vitest";import {add} from "./math";test("adds",()=>expect(add(2,3)).toBe(5))')
      await kernel.writeText('/project/probe.mjs',phase==='serialization'
        ?`import v8 from 'node:v8';const value={m:'fetch',a:['/@vite/env','ssr'],i:'request',t:'q'};
          if(typeof v8.serialize!=='function'||typeof v8.deserialize!=='function')throw Error('Missing v8 serialize/deserialize');
          const encoded=v8.serialize(value);if(!Buffer.isBuffer(encoded)||JSON.stringify(v8.deserialize(encoded))!==JSON.stringify(value))throw Error('RPC serialization mismatch');console.log('SERIALIZATION_OK');`
        :phase==='memory'
        ?`import {memoryUsage} from 'node:process';const before=memoryUsage();globalThis.retainedMemory=new Uint8Array(1024*1024);const after=memoryUsage();
          if(!Number.isFinite(before.heapUsed)||after.heapUsed-before.heapUsed<1024*1024||after.heapTotal<after.heapUsed)throw Error('Guest allocation was not measured');
          try{memoryUsage.rss();throw Error('RSS unexpectedly available')}catch(error){if(error.code!=='ERR_UNSUPPORTED_OPERATION')throw error}console.log('MEMORY_OK');`
        :phase==='discovery'
        ?`import fs from 'node:fs';import {glob} from 'tinyglobby';
          console.log('DISCOVERY '+JSON.stringify({cwd:process.cwd(),execArgv:process.execArgv,files:fs.readdirSync('/project',{withFileTypes:true}).map(d=>({name:d.name,file:d.isFile(),directory:d.isDirectory()})),all:await glob('**/*',{cwd:'/project',ignore:['**/node_modules/**']}),tests:await glob('**/*.{test,spec}.?(c|m)[jt]s?(x)',{cwd:'/project',dot:true,ignore:['**/node_modules/**'],expandDirectories:false})}));`
        :phase==='async-emitter'?asyncEmitterSource:phase==='ports'
        ?`import {MessageChannel,receiveMessageOnPort} from 'node:worker_threads';
          const {port1,port2}=new MessageChannel();let events=0;port2.onmessage=()=>events++;
          port1.postMessage({answer:42});const value=receiveMessageOnPort(port2);if(value.message.answer!==42||receiveMessageOnPort(port2)!==undefined)throw Error('Bad synchronous receive');
          await new Promise(resolve=>setTimeout(resolve,20));if(events)throw Error('Duplicate event');
          port2.onmessage=null;
          const seen=[];const listener=value=>seen.push(value);port2.on('message',listener);port2.on('message',listener);
          await new Promise(resolve=>{port2.once('message',resolve);port1.postMessage(7)});
          if(JSON.stringify(seen)!=='[7]'||port2.listenerCount('message')!==1)throw Error('Node port listener mismatch');
          port2.removeAllListeners('message');if(port2.listenerCount('message')!==0)throw Error('Port listener removal failed');
          port1.close();port2.close();console.log('PORTS_OK')`
        :phase==='console'
        ?`import {Console} from 'node:console';import {Writable} from 'node:stream';
          const out=[],err=[];const stdout=new Writable({write(chunk,encoding,done){out.push(String(chunk));done()}});const stderr=new Writable({write(chunk,encoding,done){err.push(String(chunk));done()}});
          const logger=new Console({stdout,stderr,colorMode:false});const {log}=logger;log('%s %d','answer',42);logger.error('failure');
          if(out.join('')!=='answer 42\\n'||err.join('')!=='failure\\n')throw Error('Console output mismatch');console.log('CONSOLE_OK')`
        :phase==='cancel'
        ?`import {createVitest} from 'vitest/node';import {writeFileSync,existsSync} from 'node:fs';
          writeFileSync('/project/math.test.ts',\`import {test,expect} from 'vitest';import {writeFileSync,existsSync} from 'node:fs';
            test('active',async()=>{writeFileSync('/project/started','yes');while(!existsSync('/project/release'))await new Promise(resolve=>setTimeout(resolve,20));writeFileSync('/project/finished','yes')});
            test('queued',()=>{writeFileSync('/project/queued','unexpected')});\`);
          const ctx=await createVitest('test',{root:'/project',watch:false,config:false,maxWorkers:1,testTimeout:10000});
          try{
            const startupAt=Date.now();const running=ctx.start([]);const deadline=startupAt+20000;
            while(!existsSync('/project/started')){if(Date.now()>deadline)throw Error('Active test did not start');await new Promise(resolve=>setTimeout(resolve,20))}
            console.log('CANCEL_STARTUP_MS '+(Date.now()-startupAt));const cancellationAt=Date.now();
            const cancellation=ctx.cancelCurrentRun('keyboard-input');
            setTimeout(()=>writeFileSync('/project/release','yes'),500);
            await cancellation;await running;
            console.log('CANCEL_SETTLED_MS '+(Date.now()-cancellationAt));
            if(!existsSync('/project/finished')||existsSync('/project/queued'))throw Error('Graceful cancellation did not finish active work and skip queued work');
            console.log('CANCELLED_ACTIVE_RUN');
            writeFileSync('/project/math.test.ts','import {test,expect} from "vitest";import {add} from "./math";test("recovered",()=>expect(add(2,3)).toBe(5))');
            ctx.invalidateFile('/project/math.test.ts');await ctx.rerunFiles(['/project/math.test.ts'],'after cancellation');
            const files=ctx.state.getFiles();if(files.length!==1||files[0].result?.state!=='pass'||files[0].tasks[0]?.name!=='recovered')throw Error('Rerun after cancellation failed');
            process.exitCode=0;console.log('VITEST_RESULT recovered');
          }finally{await ctx.close()}`
        :phase==='watch'
        ?`import {createVitest} from 'vitest/node';import {writeFileSync} from 'node:fs';
          let completed=0;const runs=[];
          const ctx=await createVitest('test',{root:'/project',watch:true,config:false,maxWorkers:1,reporters:[{onFinished(files,errors){runs.push({states:files.map(file=>file.result?.state),errors:errors.length,assertions:files.flatMap(file=>file.tasks.flatMap(task=>task.result?.errors?.map(error=>error.message)??[]))});completed++}}]});
          async function waitForRun(count){const deadline=Date.now()+10000;while(completed<count){if(Date.now()>deadline)throw Error('Watch run timed out: '+JSON.stringify({count,completed,runs}));await new Promise(resolve=>setTimeout(resolve,20))}}
          try{
            await ctx.start([]);await waitForRun(1);
            for(const [index,operator] of ['-','+','-','+'].entries()){
              writeFileSync('/project/math.ts','export const add=(a:number,b:number)=>a'+operator+'b');
              await waitForRun(index+2);
              const expected=operator==='+'?'pass':'fail';const run=runs[index+1];
              if(run.errors||JSON.stringify(run.states)!==JSON.stringify([expected]))throw Error('Watch result mismatch: '+JSON.stringify({expected,run}));
              if(expected==='fail'&&!run.assertions.some(message=>message.includes('expected -1 to be 5')))throw Error('Watch failure was not the intended assertion: '+JSON.stringify(run));
            }
            if(runs[0].errors||JSON.stringify(runs[0].states)!=='["pass"]')throw Error('Initial run failed');
            process.exitCode=0;console.log('VITEST_RESULT '+JSON.stringify(runs));
          }finally{await ctx.close()}`
        :phase==='import'
        ?'import {startVitest} from "vitest/node";console.log(typeof startVitest)'
        :`import {startVitest,createVitest} from 'vitest/node';
          ${traceIPC?`const {ViteNodeServer}=await import('vite-node/server');
          for(const name of ['fetchResult','_fetchModule','_transformRequest']){
            const original=ViteNodeServer.prototype[name];if(typeof original!=='function')continue;
            ViteNodeServer.prototype[name]=async function(...args){console.log('FETCH_TRACE '+name+' begin '+JSON.stringify(args));try{const value=await original.apply(this,args);console.log('FETCH_TRACE '+name+' complete');return value}catch(error){console.log('FETCH_TRACE '+name+' error '+String(error));throw error}};
          }
          const proc=globalThis.__webContainerHost.proc,call=proc.call,next=proc.ipcNext;
          proc.call=function(method,...args){
            if(method==='fork')console.log('IPC_TRACE fork '+JSON.stringify(args));
            try{const result=call(method,...args);if(method==='fork'||method==='ipcSend'||method==='ipcDisconnect')console.log('IPC_TRACE '+method+' result '+JSON.stringify(result));return result}
            catch(error){console.log('IPC_TRACE '+method+' error '+String(error));throw error}
          };
          proc.ipcNext=async function(pid){const bytes=await next(pid);console.log('IPC_TRACE receive '+pid+' '+(bytes===null?'EOF':Buffer.from(bytes).toString('utf8')));return bytes};`:''}
          const ctx=${phase==='repair'?`await createVitest('test',{root:'/project',watch:false,config:false,maxWorkers:1});await ctx.start([])`:`await startVitest('test',[],{root:'/project',watch:false,config:false,maxWorkers:1})`};
          if(!ctx)throw Error('Vitest did not start');
          try{
            ${phase==='repair'?`const initial=ctx.state.getFiles();if(initial.length!==1||initial[0].result?.state!=='fail')throw Error('Expected initial assertion failure');
            const failed=initial[0].tasks.find(task=>task.name==='adds');
            if(failed?.result?.state!=='fail'||!failed.result.errors?.some(error=>error.message.includes('expected -1 to be 5')))throw Error('Initial failure was not the intended assertion: '+JSON.stringify(failed?.result));
            console.log('REPAIR_INITIAL_FAILED');const {writeFileSync}=await import('node:fs');
            writeFileSync('/project/math.ts','export const add=(a:number,b:number)=>a+b');
            ctx.invalidateFile('/project/math.ts');await ctx.rerunFiles(['/project/math.test.ts'],'source repaired');
            process.exitCode=0;`:''}
            console.log('VITEST_PROJECTS '+JSON.stringify(await Promise.all(ctx.projects.map(async p=>({root:p.config.root,dir:p.config.dir,include:p.config.include,exclude:p.config.exclude,files:await p.globTestFiles()})))));const files=ctx.state.getFiles();console.log('VITEST_RESULT '+JSON.stringify(files.map(file=>({name:file.name,state:file.result?.state}))));if(!files.length||files.some(file=>file.result?.state!=='pass'))throw Error('Tests did not pass')}finally{await ctx.close()}`)
      stage=phase
      let terminated
      let cancellation
      if(phase==='kill'||phase==='cpu-kill'){
        await kernel.writeText('/project/math.test.ts',`import {test} from 'vitest';import {writeFileSync} from 'node:fs';
          test('hung',async()=>{let ticks=0;writeFileSync('/project/started','yes');setInterval(()=>writeFileSync('/project/heartbeat',String(++ticks)),20);${phase==='cpu-kill'?`setTimeout(()=>{writeFileSync('/project/cpu-entered','yes');while(true){}},100);`:''}await new Promise(()=>{})},60000)`)
        const child=await kernel.spawn('node',['/project/probe.mjs'],{cwd:'/project',guestWasm:true,webAPIs:true,maxBytes:processMiB*1024*1024,timeoutMs:30000})
        const drain=(async()=>{while(await child.next()){} })()
        try{
          const deadline=Date.now()+30000
          while(true){
            try{if(Number(await kernel.readText('/project/heartbeat'))>=2)break}catch{}
            if(Date.now()>deadline)throw Error('Hung Vitest test did not start')
            await new Promise(resolve=>setTimeout(resolve,20))
          }
          if(phase==='cpu-kill')while(true){
            try{if(await kernel.readText('/project/cpu-entered')==='yes')break}catch{}
            if(Date.now()>deadline)throw Error('CPU loop did not start')
            await new Promise(resolve=>setTimeout(resolve,20))
          }
          const killStarted=performance.now()
          const killed=await child.kill('SIGKILL')
          terminated=await child.wait();await drain
          const killMs=performance.now()-killStarted
          cancellation={killed,killMs}
          if(!killed)throw Error('Active Vitest process was not killed: '+JSON.stringify({killMs,terminated}))
          if(phase==='cpu-kill'&&killMs>2000)throw Error('CPU-bound kill exceeded 2 seconds: '+Math.round(killMs)+' ms')
          if(terminated.signal!=='SIGKILL')throw Error('Missing kill signal: '+JSON.stringify(terminated))
          const heartbeat=await kernel.readText('/project/heartbeat')
          await new Promise(resolve=>setTimeout(resolve,150))
          if(await kernel.readText('/project/heartbeat')!==heartbeat)throw Error('Child test still running after parent kill')
        }finally{await child.dispose()}
        await kernel.writeText('/project/math.test.ts','import {test,expect} from "vitest";import {add} from "./math";test("adds",()=>expect(add(2,3)).toBe(5))')
      }
      const execution=await kernel.runModule('/project/probe.mjs',{guestWasm:true,webAPIs:true,maxBytes:processMiB*1024*1024,timeoutMs:30000})
      return {installation,stage,execution,processMiB,terminated,cancellation,cooperative}
    }catch(error){return {stage,error:String(error)}}finally{kernel.close()}
  },{files,phase,asyncEmitterSource,traceIPC:process.env.IPC_TRACE==='1',processMiB,cooperative})
  await info.attach('vitest-result.json',{body:JSON.stringify(result),contentType:'application/json'})
  if(phase==='cancel')console.log(info.project.name,result.execution?.stdout.match(/CANCEL_(?:STARTUP|SETTLED)_MS \d+/g))
  expect(result.error,JSON.stringify(result)).toBeUndefined()
  expect(result.execution?.exitCode,JSON.stringify(result)).toBe(0)
  if(phase==='repair')expect(result.execution?.stdout).toContain('REPAIR_INITIAL_FAILED')
  if(phase==='cancel')expect(result.execution?.stdout).toContain('CANCELLED_ACTIVE_RUN')
  if(phase==='discovery'){
    const details=JSON.parse(result.execution!.stdout.trim().slice('DISCOVERY '.length))
    expect(details.tests,JSON.stringify(details)).toEqual(['math.test.ts'])
  }else if(phase==='async-emitter')expect(JSON.parse(result.execution!.stdout.trim())).toEqual([
    ['listener','created',true,42,true],['caller','caller'],['promise','created'],
    ['throw','listener failure','throwing caller'],['resource',true,true],['return',true,false,null],
  ])
  else expect(result.execution?.stdout).toContain(phase==='serialization'?'SERIALIZATION_OK':phase==='memory'?'MEMORY_OK':phase==='ports'?'PORTS_OK':phase==='console'?'CONSOLE_OK':phase==='import'?'function':'VITEST_RESULT')
})
