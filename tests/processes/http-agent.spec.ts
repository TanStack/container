import {expect,test} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'keep-alive agent reuses an idle connection':`
    import http from 'node:http';let connections=0;const server=http.createServer((req,res)=>res.end(req.url));server.on('connection',()=>connections++);await new Promise(r=>server.listen(0,'127.0.0.1',r));const agent=new http.Agent({keepAlive:true});const seen=[];
    for(const path of ['/one','/two'])seen.push(await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path,agent},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve([body,req.reusedSocket]))});req.on('error',reject)}));seen.push(connections,Object.values(agent.freeSockets).flat().length);agent.destroy();await new Promise(r=>server.close(r));console.log(JSON.stringify(seen));`,
  'maxSockets queues requests and reuses the released socket':`
    import http from 'node:http';let release,connections=0;const gate=new Promise(r=>release=r);const server=http.createServer(async(req,res)=>{if(req.url==='/one')await gate;res.end(req.url)});server.on('connection',()=>connections++);await new Promise(r=>server.listen(0,'127.0.0.1',r));const agent=new http.Agent({keepAlive:true,maxSockets:1});
    const run=path=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path,agent},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve([body,req.reusedSocket]))});req.on('error',reject)});const one=run('/one'),two=run('/two');await new Promise(r=>setTimeout(r,10));const queued=Object.values(agent.requests).flat().length;release();const seen=await Promise.all([one,two]);agent.destroy();await new Promise(r=>server.close(r));console.log(JSON.stringify([seen,queued,connections]));`,
}

for(const guestWasm of [false,true])for(const [name,source] of Object.entries(cases))test(`${guestWasm?'WASM bridge':'default engine'}: ${name}`,async({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,timeoutMs:15000})}finally{kernel.close()}
  },{source,guestWasm})
  await info.attach('http-agent.json',{body:JSON.stringify({node:node.stdout,nodeVersion:process.version,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(node.stdout)
})
