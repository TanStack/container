import {test,expect} from '@playwright/test'

test('one kernel stays clean across ordinary sequential development cycles',async({page},info)=>{
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(String(error)))
  page.on('crash',()=>errors.push('Page crashed'))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/package.json':JSON.stringify({name:'long-session-fixture',version:'1.0.0'}),
      '/cycle.mjs':`import fs from 'node:fs';
        import {exec} from 'node:child_process';
        import {promisify} from 'node:util';
        import http from 'node:http';
        import {Worker} from 'node:worker_threads';
        const worker=new Worker('import {parentPort} from "node:worker_threads";parentPort.postMessage(21*2)',{eval:true,execArgv:['--input-type=module']});
        const answer=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});await worker.terminate();
        const shell=await promisify(exec)("printf 'shell-ready'");
        await fs.promises.writeFile('/watched','before');
        const watched=new Promise((resolve,reject)=>{const watcher=fs.watch('/watched',(event,file)=>{watcher.close();resolve(event+':'+file)});watcher.on('error',reject)});
        await fs.promises.writeFile('/watched','after');const watchEvent=await watched;
        const server=http.createServer((request,response)=>{response.setHeader('content-type','text/html');response.end('<h1>cycle preview</h1>')});
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8123,'127.0.0.1',resolve)});
        const agent=new http.Agent({keepAlive:true});
        const body=await new Promise((resolve,reject)=>{http.get('http://127.0.0.1:8123/',{agent},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve(text))}).on('error',reject)});agent.destroy();
        console.log('READY '+JSON.stringify({answer,shell:shell.stdout,watchEvent,body}));
        await new Promise(resolve=>process.stdin.once('data',resolve));
        await new Promise(resolve=>server.close(resolve));console.log('STOPPED');`,
    })
    const cycles=[]
    try{
      const baseline=await kernel.resources()
      for(let index=0;index<4;index++){
        const installation=await kernel.install({ignoreScripts:true})
        const child=await kernel.spawn('node',['/cycle.mjs'],{lifetime:'session',timeoutMs:5000})
        let output=''
        while(!output.includes('READY ')){
          const event=await child.next()
          if(!event)throw Error('Cycle process ended before readiness')
          if(event.type==='stdout')output+=new TextDecoder().decode(event.bytes)
          if(event.type==='stderr')throw Error(new TextDecoder().decode(event.bytes))
        }
        const active=await kernel.resources()
        const preview=await window.sandboxLab.URLPreview.mount(document.querySelector('#preview')!,{
          origin:'http://127.0.0.1:4200',server:new window.sandboxLab.WorkerHTTP(kernel,8123),
        })
        const inspected=await preview.inspect()
        preview.close()
        await child.write('stop\n');await child.end()
        const completion=await child.wait();await child.dispose()
        const idle=await kernel.resources()
        if(JSON.stringify(idle)!==JSON.stringify(baseline))throw Error('Kernel did not return to its resource baseline')
        cycles.push({installation,active,idle,completion,inspected,output})
      }
      const recovery=await kernel.execute('console.log(6*7)')
      return {baseline,cycles,recovery}
    }finally{kernel.close()}
  })
  expect(errors).toEqual([])
  expect(result.baseline).toEqual({processes:{active:0,retained:0},network:{handles:0,listeners:0},fileSessions:0,executing:false,installing:false})
  expect(result.cycles).toHaveLength(4)
  for(const cycle of result.cycles){
    expect(cycle.active.processes.active).toBe(1)
    expect(cycle.active.network.listeners).toBe(1)
    expect(cycle.completion.exitCode,cycle.completion.stderr).toBe(0)
    expect(cycle.output).toContain('shell-ready')
    expect(cycle.inspected.text).toContain('cycle preview')
  }
  expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
  expect(result.recovery.stdout).toBe('42\n')
  await info.attach('long-session-lifecycle.json',{body:JSON.stringify(result),contentType:'application/json'})
})
