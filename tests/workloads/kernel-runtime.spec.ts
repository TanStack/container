import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

// Compare observable behavior, not just whether a builtin imports successfully.
const cases:Record<string,string>={
  'custom event detail': `
    const target=new EventTarget(),detail={command:'dev'};let seen;
    target.addEventListener('command:dev',event=>seen=[event instanceof Event,event instanceof CustomEvent,event.detail===detail,Object.prototype.toString.call(event)]);
    const event=new CustomEvent('command:dev',{detail,bubbles:true,cancelable:true});
    console.log(JSON.stringify({seen,detail:event.detail,type:event.type,bubbles:event.bubbles,cancelable:event.cancelable}));`,
  'event listeners and cancellation': `
    const target=new EventTarget(),seen=[],controller=new AbortController();
    const gone=()=>seen.push('gone');target.addEventListener('x',gone,{signal:controller.signal});controller.abort();
    target.addEventListener('x',function(e){seen.push(['once',this===target,e.target===target,e.eventPhase]);e.preventDefault()},{once:true});
    target.addEventListener('x',{handleEvent(e){seen.push('object')}});
    const event=new Event('x',{cancelable:true});
    const first=target.dispatchEvent(event),second=target.dispatchEvent(new Event('x'));
    console.log(JSON.stringify({seen,first,second,canceled:event.defaultPrevented,current:event.currentTarget,phase:event.eventPhase}));`,
  'abort composition and reasons': `
    const a=new AbortController(),b=new AbortController(),reason={value:7};
    const combined=AbortSignal.any([a.signal,b.signal,a.signal]),nested=AbortSignal.any([combined]);
    const seen=[];a.signal.addEventListener('abort',()=>seen.push([combined.aborted,nested.aborted]));
    combined.addEventListener('abort',()=>seen.push(combined.reason===reason));a.abort(reason);b.abort('later');
    try{nested.throwIfAborted()}catch(error){seen.push(error===reason)}
    const timeout=AbortSignal.timeout(1);await new Promise(resolve=>setTimeout(resolve,10));
    console.log(JSON.stringify({seen,timeout:timeout.reason.name,empty:AbortSignal.any([]).aborted,default:AbortSignal.abort().reason.name}));`,
  'message queue clones guest objects': `
    const channel=new MessageChannel(),input={array:new Uint16Array([3,7]),map:new Map([['a',2]])};input.self=input;
    const seen=[];channel.port1.onmessage=event=>{
      const v=event.data;seen.push([v.self===v,...v.array,v.map.get('a')]);
      channel.port1.close();channel.port2.close();console.log(JSON.stringify(seen));
    };
    channel.port2.postMessage(input);input.array[0]=99;seen.push('sync');`,
  'timer lifetime and async local storage': `
    import {AsyncLocalStorage} from 'node:async_hooks';const als=new AsyncLocalStorage(),seen=[];
    als.run('outer',()=>setTimeout(function(value){
      seen.push([value,als.getStore(),typeof this.ref]);
      Promise.resolve().then(()=>{seen.push(['microtask',als.getStore()]);setTimeout(()=>console.log(JSON.stringify(seen)),1)});
    },1,7));`,
  'interval cancellation and unref': `
    let count=0;const timer=setInterval(()=>{if(++count===3){clearInterval(timer);console.log(count)}},1);
    const ignored=setTimeout(()=>console.log('unexpected'),10000);ignored.unref();
    console.log(JSON.stringify([timer.hasRef(),ignored.hasRef(),ignored.ref().hasRef(),ignored.unref().hasRef()]));`,
  'timer refresh and numeric handles': `
    let count=0;const timer=setTimeout(()=>{if(++count<3)timer.refresh();else console.log(JSON.stringify(count))},1);
    let ticks=0;const interval=setInterval(()=>{if(++ticks===3){clearInterval(Number(interval));console.log(JSON.stringify('stopped'))}},1);`,
  'interval restores its creation context': `
    import {AsyncLocalStorage} from 'node:async_hooks';const als=new AsyncLocalStorage(),seen=[];
    als.run('initial',()=>{const timer=setInterval(()=>{
      seen.push(als.getStore());als.enterWith('changed');
      if(seen.length===2){clearInterval(timer);console.log(JSON.stringify(seen))}
    },1)});`,
  'refresh after completion captures a new context': `
    import {AsyncLocalStorage} from 'node:async_hooks';const als=new AsyncLocalStorage(),seen=[];let timer;
    als.run('first',()=>timer=setTimeout(()=>{
      seen.push(als.getStore());if(seen.length===1)setTimeout(()=>als.run('second',()=>timer.refresh()),1);
      else console.log(JSON.stringify(seen));
    },1));
    const canceled=setTimeout(()=>console.log('unexpected'),1);clearTimeout(canceled);canceled.refresh();`,
  'message channel uses receiver creation context': `
    import {AsyncLocalStorage} from 'node:async_hooks';const als=new AsyncLocalStorage();let channel;
    als.run('receiver',()=>channel=new MessageChannel());
    als.run('listener',()=>channel.port1.onmessage=()=>{console.log(JSON.stringify(als.getStore()));channel.port1.close();channel.port2.close()});
    als.run('sender',()=>channel.port2.postMessage(1));`,
  'event emitter ordering': `
    import {EventEmitter,once} from 'node:events';const emitter=new EventEmitter(),seen=[];
    emitter.on('x',v=>seen.push(v));emitter.prependOnceListener('x',v=>seen.push(v*2));
    const pending=once(emitter,'x');emitter.emit('x',3);emitter.emit('x',7);
    console.log(JSON.stringify({seen,result:await pending,listeners:emitter.listenerCount('x')}));`,
}
for(const [name,code] of Object.entries(cases)){
  test('kernel semantics | '+name,async({page})=>{
    const node=spawnSync(process.execPath,['--input-type=module'],{input:code,encoding:'utf8',timeout:10000,env:{...process.env,FORCE_COLOR:'0'}})
    expect(node.status,node.stderr).toBe(0)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async code=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':code})
      try{return await kernel.run('/entry.mjs',{webAPIs:true,timeoutMs:3000})}finally{kernel.close()}
    },code)
    expect(result.exitCode,result.stderr).toBe(0)
    expect(result.stdout).toBe(node.stdout)
  })
}

test('kernel semantics | host edits reach a persistent guest watcher',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/watched.txt':'before','/entry.mjs':`
      import {watch,readFileSync} from 'node:fs';import {AsyncLocalStorage} from 'node:async_hooks';
      const als=new AsyncLocalStorage();let count=0;als.run('watcher',()=>{
        const watcher=watch('/watched.txt',(event,filename)=>{
          console.log(JSON.stringify([event,filename,readFileSync('/watched.txt','utf8'),als.getStore()]));als.enterWith('changed');
          if(++count===2)watcher.close();else console.log('again');
        });watcher.on('close',()=>console.log('closed'));
      });console.log('ready');`})
    let write:Promise<void>|undefined
    try{
      const result=await kernel.run('/entry.mjs',{onOutput:(_level,text)=>{
        if(text.trim()==='ready')write=kernel.writeText('/watched.txt','host edit');
        if(text.trim()==='again')write=kernel.writeText('/watched.txt','second edit');
      }})
      await write;return result
    }finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout.trim().split('\n')).toEqual(['ready','["change","watched.txt","host edit","watcher"]','again','["change","watched.txt","second edit","watcher"]','closed'])
})

test('kernel semantics | watch abort, recursive paths, and unref',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/dir/sub/a':'before','/entry.mjs':`
      import {watch,writeFileSync} from 'node:fs';
      const controller=new AbortController(),seen=[];
      const watcher=watch('/dir',{recursive:true,signal:controller.signal},(event,filename)=>{seen.push([event,filename]);controller.abort()});
      watcher.on('close',()=>console.log(JSON.stringify(seen)));
      watch('/dir',{persistent:false},()=>{throw Error('nonrecursive watcher saw nested edit')});
      writeFileSync('/dir/sub/a','after');`})
    try{return await kernel.run('/entry.mjs',{webAPIs:true})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([['change','sub/a']])
})

test('kernel semantics | resource limits, callback errors, and cleanup',async({page})=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    const probes=[
      `setTimeout(()=>{throw Error('timer callback failed')},1)`,
      `queueMicrotask(()=>{throw Error('microtask failed')})`,
      `const target=new EventTarget();target.addEventListener('x',()=>{throw Error('listener failed')});target.dispatchEvent(new Event('x'))`,
      `for(let i=0;i<129;i++)setTimeout(()=>{},10000)`,
      `setInterval(()=>{},1)`,
    ]
    try{
      const results=[];for(const code of probes){
        results.push(await kernel.execute(code,{webAPIs:true,timeoutMs:1000}))
        results.push(await kernel.execute('console.log("recovered")'))
      }return results
    }finally{kernel.close()}
  })
  const errors=['timer callback failed','microtask failed','listener failed','Too many pending timers','timed out']
  for(let index=0;index<errors.length;index++){
    expect(results[index*2].exitCode).toBe(1)
    expect(results[index*2].stderr).toContain(errors[index])
    expect(results[index*2+1].exitCode).toBe(0)
    expect(results[index*2+1].stdout.trim()).toBe('recovered')
  }
})

test('kernel semantics | watcher quota and disposal across executions',async({page})=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/file':'value','/quota.mjs':`
      import {watch} from 'node:fs';for(let i=0;i<129;i++)watch('/file');`,
      '/closed.mjs':`import {watch} from 'node:fs';for(let i=0;i<512;i++)watch('/file').close();console.log('closed')`,
      '/unref.mjs':`import {watch} from 'node:fs';watch('/file').unref();console.log('unref')`,
      '/overflow.mjs':`import {watch,writeFileSync} from 'node:fs';watch('/file',()=>{});for(let i=0;i<257;i++)writeFileSync('/file',String(i));`,
    })
    try{
      const result=[];for(const entry of ['/quota.mjs','/closed.mjs','/overflow.mjs','/unref.mjs','/closed.mjs'])result.push(await kernel.run(entry))
      return result
    }finally{kernel.close()}
  })
  expect(results[0].stderr).toContain('Too many filesystem watchers')
  expect(results[2].stderr).toContain('Filesystem watch event quota exceeded')
  for(const index of [1,3,4])expect(results[index].exitCode,results[index].stderr).toBe(0)
})
