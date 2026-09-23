import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

test('published Express installs and serves routes, JSON bodies and application errors',async({page},info)=>{
  const files=Object.fromEntries(['package.json','package-lock.json'].map(name=>['/'+name,readFileSync('fixtures/install-express/'+name,'utf8')]))
  files['/main.mjs']=`
    import express from 'express';import http from 'node:http';import {Buffer} from 'node:buffer';
    const app=express();app.use(express.json());
    app.get('/hello/:name',async(req,res)=>{await Promise.resolve();res.json({hello:req.params.name})});
    app.post('/sum',(req,res)=>res.status(201).json({sum:req.body.a+req.body.b}));
    app.get('/fail',()=>{throw Error('application failed')});
    app.use((error,req,res,next)=>res.status(418).json({error:error.message}));
    const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const send=(path,body)=>new Promise((resolve,reject)=>{const text=body?JSON.stringify(body):undefined;const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:body?'POST':'GET',headers:body?{'content-type':'application/json','content-length':Buffer.byteLength(text)}:{}},res=>{let result='';res.setEncoding('utf8');res.on('data',x=>result+=x);res.on('error',reject);res.on('end',()=>resolve([res.statusCode,JSON.parse(result)]))});req.on('error',reject);req.end(text)});
    const results=[await send('/hello/browser'),await send('/sum',{a:2,b:3}),await send('/fail')];
    await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(results));
  `
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files,{workspace:{maxBytes:64*1024*1024}})
    try{const installation=await kernel.install();const execution=await kernel.runModule('/main.mjs',{guestWasm:true,webAPIs:true,maxBytes:64*1024*1024,timeoutMs:30000});return {installation,execution}}finally{kernel.close()}
  },files)
  await info.attach('express-install.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(JSON.parse(result.execution.stdout)).toEqual([[200,{hello:'browser'}],[201,{sum:5}],[418,{error:'application failed'}]])
})
