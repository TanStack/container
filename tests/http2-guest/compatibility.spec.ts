import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'

const headerSource = `
import http2,{Http2ServerRequest,Http2ServerResponse} from 'node:http2';
import assert from 'node:assert/strict';
const events=[];
const server=http2.createServer((req,res)=>{
  assert.ok(req instanceof Http2ServerRequest);assert.ok(res instanceof Http2ServerResponse);
  assert.equal(req.stream,res.stream);assert.equal(req.httpVersion,'2.0');
  assert.equal(req.method,'POST');assert.equal(req.url,'/echo?q=1');assert.equal(req.scheme,'http');
  assert.ok(req.rawHeaders.includes(':method'));assert.equal(req.complete,false);
  res.sendDate=false;res.setHeader('X-Remove','gone');res.removeHeader('x-remove');
  assert.equal(res.hasHeader('X-Remove'),false);
  res.setHeader('Set-Cookie',['a=1','b=2']);res.appendHeader('x-values','one');res.appendHeader('x-values','two');
  assert.deepEqual(res.getHeader('X-Values'),['one','two']);
  assert.equal(res.headersSent,false);res.on('finish',()=>events.push('finish'));
  let body='';req.setEncoding('utf8');req.on('data',chunk=>body+=chunk);
  req.on('end',()=>{
    assert.equal(req.complete,true);res.writeHead(201,{'x-method':req.method});assert.equal(res.headersSent,true);
    res.write('echo:');res.end(body);
  });
});
await new Promise(yes=>server.listen(0,yes));const client=http2.connect('http://localhost:'+server.address().port);
const request=client.request({':method':'POST',':path':'/echo?q=1'});let headers,body='';
await new Promise((yes,no)=>{request.on('response',value=>headers=value);request.on('data',chunk=>body+=chunk);request.on('end',yes);request.on('error',no);request.end('hello')});
assert.equal(body,'echo:hello');assert.equal(headers[':status'],201);assert.equal(headers['x-values'],'one, two');assert.deepEqual(headers['set-cookie'],['a=1','b=2']);
await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));
assert.deepEqual(events,['finish']);console.log(JSON.stringify({body,status:headers[':status'],method:headers['x-method'],cookies:headers['set-cookie'],events}));
`
const bodySource=`
import http2 from 'node:http2';import assert from 'node:assert/strict';
const lifecycle=[];
const server=http2.createServer();server.on('request',(req,res)=>{
  res.sendDate=false;res.on('finish',()=>lifecycle.push(req.url+':finish'));res.on('close',()=>lifecycle.push(req.url+':close'));
  if(req.url!=='/large'){res.statusCode=req.url==='/empty'?204:200;res.end('must not appear');return}
  req.pause();let size=0;
  req.on('data',chunk=>{assert.ok(chunk.every(byte=>byte===97));size+=chunk.length});
  req.on('end',()=>{assert.equal(req.complete,true);assert.equal(size,262144);res.end(Buffer.alloc(size,98))});
  setTimeout(()=>req.resume(),25);
});
await new Promise(yes=>server.listen(0,yes));const client=http2.connect('http://localhost:'+server.address().port);
const outputs=[];
for(const [path,method] of [['/head','HEAD'],['/empty','GET'],['/large','POST']]){
  const req=client.request({':path':path,':method':method});let size=0,status;
  await new Promise((yes,no)=>{req.on('response',headers=>status=headers[':status']);req.on('data',chunk=>{assert.ok(chunk.every(byte=>byte===98));size+=chunk.length});req.on('end',yes);req.on('error',no);
    if(method==='POST'){req.write(Buffer.alloc(131072,97));req.end(Buffer.alloc(131072,97))}
  });
  assert.equal(size,path==='/large'?262144:0);assert.equal(status,path==='/empty'?204:200);outputs.push({path,status,size});
}
await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));
assert.deepEqual(lifecycle.sort(),['/head:finish','/head:close','/empty:finish','/empty:close','/large:finish','/large:close'].sort());
console.log(JSON.stringify({outputs,lifecycle}));
`
for (const [name,source] of Object.entries({headers:headerSource,bodies:bodySource})) for (const guestWasm of [false,true]) test(`HTTP/2 request response ${name} (${guestWasm ? 'bridge' : 'default'})`,async ({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async ({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,maxBytes:32*1024*1024,timeoutMs:15000})}
    finally{kernel.close()}
  },{source,guestWasm})
  await info.attach('http2-compatibility.json',{body:JSON.stringify({node:node.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(node.stdout)
})
