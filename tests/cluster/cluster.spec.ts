import {expect,test} from '@playwright/test'

for(const guestWasm of [false,true])test(`process-backed node:cluster ${guestWasm?'WASM':'default'}`,async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>Boolean(window.sandboxLab))
  const result=await page.evaluate(async guestWasm=>{
    const source=`import cluster from 'node:cluster';import http from 'node:http';if(cluster.isWorker){http.createServer((_request,response)=>response.end(String(cluster.worker.id))).listen(8126,'127.0.0.1')}else{cluster.setupPrimary({exec:'/main.mjs',serialization:'advanced'});const workers=[cluster.fork(),cluster.fork()],listening=[];cluster.on('listening',worker=>{listening.push(worker.id);if(listening.length===2)run()});const request=()=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:8126,agent:false},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve(Number(body)))}).on('error',reject));async function run(){const before=[];for(let i=0;i<4;i++)before.push(await request());workers[0].disconnect();await new Promise(resolve=>workers[0].once('exit',resolve));const after=[await request(),await request()];workers[1].disconnect();await new Promise(resolve=>workers[1].once('exit',resolve));console.log(JSON.stringify({before,after,listening}))}}`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return {run:await kernel.execute('/main.mjs',{guestWasm}),resources:await kernel.resources()}}finally{kernel.close()}
  },guestWasm)
  expect(result.run.exitCode,result.run.stderr).toBe(0);const value=JSON.parse(result.run.stdout),[first,second]=value.listening;expect(value.before).toEqual([first,second,first,second]);expect(value.after).toEqual([second,second]);expect(result.resources.processes).toEqual({active:0,retained:0});expect(result.resources.network).toEqual({handles:0,listeners:0})
})
