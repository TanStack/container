export const exchange = `
import net from 'node:net';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
const call=globalThis.__webContainerHost.http2.call;
const total=2*1024*1024+19;
let resolve,reject;
const done=new Promise((yes,no)=>{resolve=yes;reject=no});
let serverPeer,clientPeer,received=0,status,custom;
function peer(socket,server){
  const id=call('open',server);
  let scheduled=false,writing=false,dead=false,producer;
  const headers=new Map();
  function schedule(){if(!scheduled&&!dead){scheduled=true;setImmediate(pump)}}
  function pump(){
    scheduled=false;if(dead)return;
    try{
      if(producer){
        const available=65536-call('queued',id,producer.stream);
        if(available){
          const length=Math.min(available,total-producer.offset);
          const bytes=Array.from({length},(_,i)=>(producer.offset+i)%251);
          producer.offset+=call('write',id,producer.stream,bytes,producer.offset+length===total);
          if(producer.offset===total)producer=null;
        }
      }
      if(writing)return;
      const bytes=call('send',id,16384);
      if(bytes.length){writing=true;socket.write(Buffer.from(bytes),error=>{writing=false;if(error)reject(error);else schedule()})}
    }catch(error){reject(error)}
  }
  socket.on('data',bytes=>{
    try{
      for(let offset=0;offset<bytes.length;offset+=16384){
        call('feed',id,Array.from(bytes.subarray(offset,offset+16384)));
        for(const event of call('events',id)){
          if(event.type===1){
            const text=Buffer.from(event.bytes).toString(),split=text.indexOf('\\0');
            let values=headers.get(event.stream);if(!values)headers.set(event.stream,values={});
            values[text.slice(0,split)]=text.slice(split+1);
          }
          if(event.type===2){
            assert.equal(server,false);
            for(let i=0;i<event.bytes.length;i++)assert.equal(event.bytes[i],(received+i)%251);
            received+=event.bytes.length;call('consume',id,event.stream,event.bytes.length);
          }
          if(event.type===3&&(event.flags&1)){
            const values=headers.get(event.stream);
            if(server){
              assert.equal(values[':method'],'GET');assert.equal(values[':path'],'/headers');assert.equal(values['x-empty'],'');
              assert.equal(values.cookie,'a=1; b=2');
              call('headers',id,event.stream, [[':status','201'],['content-type','application/octet-stream'],['x-answer','42']],false);
              producer={stream:event.stream,offset:0};
            }else{status=values[':status'];custom=values['x-answer'];resolve()}
          }
        }
      }
      schedule();
    }catch(error){reject(error)}
  });
  socket.on('error',reject);
  schedule();
  return {id,schedule,close(){dead=true;call('destroy',id);socket.destroy()}};
}
const server=net.createServer(socket=>{serverPeer=peer(socket,true)});
await new Promise((yes,no)=>{server.once('error',no);server.listen(0,yes)});
const socket=net.connect(server.address().port);
await new Promise((yes,no)=>{socket.once('connect',yes);socket.once('error',no)});
clientPeer=peer(socket,false);
call('headers',clientPeer.id,0,[[':method','GET'],[':scheme','http'],[':authority','localhost'],[':path','/headers'],['cookie','a=1; b=2'],['x-empty','']],true);
clientPeer.schedule();
await done;
assert.equal(received,total);assert.equal(status,'201');assert.equal(custom,'42');
clientPeer.close();serverPeer.close();await new Promise(yes=>server.close(yes));
console.log(JSON.stringify({received,status,custom}));
`

export const crossProcess = `
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const call=globalThis.__webContainerHost.http2.call;
const handle=call('open',false);
const child=spawn('node',['-e',\`try{globalThis.__webContainerHost.http2.call('send',\${handle});console.log('allowed')}catch(error){console.log(error.code)}\`]);
let output='';child.stdout.on('data',bytes=>output+=bytes.toString());
await new Promise((yes,no)=>{child.once('error',no);child.once('close',code=>code===0?yes():no(Error('child failed')))});
assert.equal(output.trim(),'EBADF');
assert.ok(call('send',handle).length>0);
console.log('child denied; parent session intact');
`
