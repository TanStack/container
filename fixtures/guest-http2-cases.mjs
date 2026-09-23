export const guestHTTP2Cases = {
  'streamed response trailers wait for delayed send including empty trailers': `
import http2 from 'node:http2';import assert from 'node:assert/strict';
const wants=[];const server=http2.createServer();
server.on('stream',(stream,headers)=>{
 const empty=headers[':path']==='/empty';
 stream.on('error',()=>{});
 stream.on('wantTrailers',()=>{wants.push(empty?'empty':'full');setTimeout(()=>stream.sendTrailers(empty?{}:{'x-checksum':'done'}),5)});
 stream.respond({':status':200},{waitForTrailers:true});stream.write('first');setTimeout(()=>stream.end('second'),2);
});
await new Promise(yes=>server.listen(0,yes));const client=http2.connect('http://localhost:'+server.address().port);
const results=[];
for(const path of ['/full','/empty']){
 const request=client.request({':path':path}),events=[];let body='',trailers;
 await new Promise((yes,no)=>{request.on('response',()=>events.push('response'));request.on('data',chunk=>{body+=chunk;events.push('data')});request.on('trailers',value=>{trailers=value;events.push('trailers')});request.on('end',()=>{events.push('end');yes()});request.on('error',no)});
 assert.equal(body,'firstsecond');assert.equal(events[0],'response');assert.equal(events.at(-1),'end');
 if(path==='/full'){assert.equal(trailers['x-checksum'],'done');assert.ok(events.indexOf('trailers')>events.lastIndexOf('data'))}
 else assert.equal(trailers===undefined||Object.keys(trailers).length===0,true);
 results.push({path,body,checksum:trailers?.['x-checksum']??null});
}
assert.deepEqual(wants,['full','empty']);
await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));console.log(JSON.stringify(results));
`,
  'request trailers arrive before stream end and preserve streamed body': `
import http2 from 'node:http2';import assert from 'node:assert/strict';
const server=http2.createServer();
server.on('stream',stream=>{
 const events=[];let body='',trailers;
 stream.on('data',chunk=>{body+=chunk;events.push('data')});stream.on('trailers',value=>{trailers=value;events.push('trailers')});
 stream.on('end',()=>{events.push('end');stream.respond();stream.end(JSON.stringify({body,checksum:trailers?.['x-upload'],events}))});
});
await new Promise(yes=>server.listen(0,yes));const client=http2.connect('http://localhost:'+server.address().port);
const request=client.request({':method':'POST',':path':'/upload'},{waitForTrailers:true});let wants=0,output='';
request.on('wantTrailers',()=>{wants++;setTimeout(()=>request.sendTrailers({'x-upload':'complete'}),5)});
const completed=new Promise((yes,no)=>{request.on('data',chunk=>output+=chunk);request.on('end',yes);request.on('error',no)});
request.write('part-one');setTimeout(()=>request.end('part-two'),2);await completed;
const result=JSON.parse(output);assert.equal(wants,1);assert.equal(result.body,'part-onepart-two');assert.equal(result.checksum,'complete');
assert.equal(result.events.at(-1),'end');assert.ok(result.events.indexOf('trailers')>result.events.lastIndexOf('data'));
await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));console.log(JSON.stringify({body:result.body,checksum:result.checksum,wants}));
`,
  'compatibility request trailers and response addTrailers are visible after streamed bodies': `
import http2 from 'node:http2';import assert from 'node:assert/strict';
const server=http2.createServer((request,response)=>{
 let body='';request.on('data',chunk=>body+=chunk);
 request.on('end',()=>{
  response.setHeader('content-type','application/json');response.write(JSON.stringify({body,upload:request.trailers['x-upload'],raw:request.rawTrailers}));
  response.addTrailers({'x-result':'complete'});setTimeout(()=>response.end(),2);
 });
});
await new Promise(yes=>server.listen(0,yes));const client=http2.connect('http://localhost:'+server.address().port);
const request=client.request({':method':'POST'},{waitForTrailers:true});let output='',trailers;
request.on('wantTrailers',()=>request.sendTrailers({'x-upload':'received'}));
const completed=new Promise((yes,no)=>{request.on('data',chunk=>output+=chunk);request.on('trailers',value=>trailers=value);request.on('end',yes);request.on('error',no)});
request.end('payload');await completed;const result=JSON.parse(output);
assert.equal(result.body,'payload');assert.equal(result.upload,'received');assert.deepEqual(result.raw,['x-upload','received']);assert.equal(trailers['x-result'],'complete');
await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));console.log(JSON.stringify({body:result.body,upload:result.upload,result:trailers['x-result']}));
`,
  'resetting one stream leaves the session usable': `
import http2 from 'node:http2';import assert from 'node:assert/strict';
const server=http2.createServer();server.on('stream',(stream,headers)=>{stream.on('error',()=>{});stream.respond();stream.end(headers[':path']==='/cancel'?Buffer.alloc(524288,42):'alive')});
await new Promise(yes=>server.listen(0,yes));const client=http2.connect('http://localhost:'+server.address().port);
const cancelled=client.request({':path':'/cancel'});cancelled.on('error',()=>{});
await new Promise(yes=>{cancelled.once('response',()=>cancelled.close(http2.constants.NGHTTP2_CANCEL));cancelled.once('close',yes)});
const next=client.request({':path':'/next'});let value='';
await new Promise((yes,no)=>{next.on('data',bytes=>value+=bytes);next.once('end',yes);next.once('error',no)});
assert.equal(value,'alive');assert.equal(cancelled.rstCode,8);
await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));console.log(JSON.stringify({value,reset:cancelled.rstCode}));
`,
  'explicit readable reads return receive credits': `
import http2 from 'node:http2';import assert from 'node:assert/strict';
const server=http2.createServer();server.on('stream',stream=>{stream.respond();stream.end(Buffer.alloc(262144,23))});
await new Promise(yes=>server.listen(0,yes));const client=http2.connect('http://localhost:'+server.address().port),request=client.request();
let length=0;
await new Promise((yes,no)=>{request.on('readable',()=>{let bytes;while((bytes=request.read(7000))!==null){assert.ok(bytes.every(byte=>byte===23));length+=bytes.length}});request.once('end',yes);request.once('error',no)});
assert.equal(length,262144);await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));console.log(length);
`,
  'multiplexed requests, custom headers and graceful session close': `
import http2 from 'node:http2';import assert from 'node:assert/strict';
const server=http2.createServer();
server.on('stream',(stream,headers)=>{
  const chunks=[];stream.on('data',bytes=>chunks.push(bytes));stream.on('error',()=>{});
  stream.on('end',()=>{stream.respond({':status':201,'x-method':headers[':method'],'set-cookie':['a=1','b=2']});stream.end(Buffer.concat(chunks))});
});
await new Promise((yes,no)=>{server.once('error',no);server.listen(0,yes)});
const client=http2.connect('http://localhost:'+server.address().port);
await new Promise((yes,no)=>{client.once('connect',yes);client.once('error',no)});
const results=await Promise.all([0,11,262144].map(length=>new Promise((yes,no)=>{
  const request=client.request({':method':length?'POST':'GET',':path':'/echo'});
  let headers;const chunks=[];
  request.on('response',value=>headers=value);request.on('data',bytes=>chunks.push(bytes));request.on('error',no);
  request.on('end',()=>{const body=Buffer.concat(chunks);assert.equal(body.length,length);assert.ok(body.every(byte=>byte===97));yes({length:body.length,status:headers[':status'],method:headers['x-method'],cookies:headers['set-cookie']})});
  if(length)request.end(Buffer.alloc(length,97));
})));
await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));console.log(JSON.stringify(results));
`,
  'paused readable applies backpressure then resumes': `
import http2 from 'node:http2';import assert from 'node:assert/strict';
let writeFinished=false;
const server=http2.createServer();server.on('stream',stream=>{stream.respond();stream.end(Buffer.alloc(524288,42),()=>writeFinished=true)});
await new Promise(yes=>server.listen(0,yes));
const client=http2.connect('http://localhost:'+server.address().port);
const request=client.request();request.on('error',error=>{throw error});
await new Promise(yes=>setTimeout(yes,100));
const paused=request.readableLength>0&&request.readableLength<=65535&&!writeFinished;assert.equal(paused,true);
let bytes=0;await new Promise((yes,no)=>{request.on('data',chunk=>{assert.ok(chunk.every(byte=>byte===42));bytes+=chunk.length});request.on('end',yes);request.on('error',no)});
assert.equal(bytes,524288);await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));console.log(JSON.stringify({paused,bytes}));
`,
  'request callbacks retain async local storage': `
import http2 from 'node:http2';import {AsyncLocalStorage} from 'node:async_hooks';import assert from 'node:assert/strict';
const als=new AsyncLocalStorage(),server=http2.createServer();server.on('stream',stream=>{stream.respond();stream.end('answer')});
await new Promise(yes=>server.listen(0,yes));const client=http2.connect('http://localhost:'+server.address().port);
await new Promise(yes=>client.once('connect',yes));
const seen=[];
await als.run('request',()=>new Promise((yes,no)=>{
  const stream=client.request();stream.on('error',no);
  stream.on('response',()=>seen.push(als.getStore()));stream.on('data',()=>seen.push(als.getStore()));stream.on('end',()=>{seen.push(als.getStore());yes()});
}));
assert.deepEqual(seen,['request','request','request']);
await new Promise(yes=>client.close(yes));await new Promise(yes=>server.close(yes));console.log(JSON.stringify(seen));
`,
}
