const parentSource=execArgv=>`const {Worker}=require('node:worker_threads');
    const worker=new Worker('./preload-child.mjs',${JSON.stringify({execArgv,stdout:true,stderr:true})});
    let message;worker.on('message',value=>message=value);worker.stdout.resume();worker.stderr.pipe(process.stderr);
    worker.once('error',error=>{console.error(error);process.exitCode=1});
    worker.once('exit',code=>{console.log(JSON.stringify({code,message}));if(code!==0)process.exitCode=1});`
export const nativeWorkerPreloadFlags=['--require','./preload-first.cjs','--import','./preload-second.mjs']
export const nativeWorkerPreloadFiles={
  '/app/preload-first.cjs':'globalThis.preloadEvents=["require"];',
  '/app/preload-second.mjs':'globalThis.preloadEvents.push("import-start");await new Promise(resolve=>setTimeout(resolve,10));globalThis.preloadEvents.push("import-done");',
  '/app/preload-child.mjs':'import {parentPort} from "node:worker_threads";globalThis.preloadEvents.push("entry");parentPort.postMessage({events:globalThis.preloadEvents});parentPort.close();',
  '/app/preload-parent.cjs':parentSource(nativeWorkerPreloadFlags),
  '/app/preload-inherited-parent.cjs':parentSource(),
  '/app/preload-nested-parent.cjs':`const {Worker}=require('node:worker_threads');
    const worker=new Worker('./preload-middle.mjs',{stdout:true,stderr:true});
    worker.stdout.resume();worker.stderr.pipe(process.stderr);
    let message;worker.on('message',value=>message=value);
    worker.on('error',error=>{console.error(error);process.exitCode=1});
    worker.on('exit',code=>{console.log(JSON.stringify({code,message}));if(code)process.exitCode=1});`,
  '/app/preload-middle.mjs':`import {Worker,parentPort} from 'node:worker_threads';
    const collect=options=>new Promise((resolve,reject)=>{
      const child=new Worker('./preload-leaf.mjs',options);
      let message;child.on('message',value=>message=value);child.on('error',reject);
      child.on('exit',code=>code?reject(Error('child exit '+code)):resolve(message));
    });
    const inherited=await collect({});const disabled=await collect({execArgv:[]});
    parentPort.postMessage({events:globalThis.preloadEvents,inherited,disabled});parentPort.close();`,
  '/app/preload-leaf.mjs':`import {parentPort} from 'node:worker_threads';
    parentPort.postMessage({events:globalThis.preloadEvents??null,flags:process.execArgv});parentPort.close();`,
}
export const nativeWorkerPreloadExpected={code:0,message:{events:['require','import-start','import-done','entry']}}
export const nativeWorkerNestedPreloadExpected={code:0,message:{events:['require','import-start','import-done'],inherited:{events:['require','import-start','import-done'],flags:nativeWorkerPreloadFlags},disabled:{events:null,flags:[]}}}
