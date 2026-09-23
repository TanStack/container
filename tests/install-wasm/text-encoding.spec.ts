import {test,expect} from '@playwright/test'
import {createHash} from 'node:crypto'

const exercise=`
const rows=[];
const texts=['','ASCII',String.fromCharCode(...Array.from({length:128},(_,i)=>i)),'é日本語😀','\\ud800','\\udfff',... [4095,4096,4097,65536].map(n=>'a'.repeat(n)), 'a'.repeat(8192)+'€'];
for(const text of texts){
  const bytes=new TextEncoder().encode(text);
  rows.push({length:bytes.length,hash:sha(bytes),decoded:new TextDecoder().decode(bytes)});
  for(const size of [0,1,2,3,4,8]){
    const destination=new Uint8Array(size),result=new TextEncoder().encodeInto(text,destination);
    rows.push({result,bytes:[...destination]});
  }
}
for(const fatal of [false,true])for(const ignoreBOM of [false,true]){
  for(const parts of [[[65],[66]],[[239],[187],[191,65]],[[226],[130],[172,65]],[[226],[65]],[[255],[65]],[[65,66],[]]]){
    const decoder=new TextDecoder('utf-8',{fatal,ignoreBOM}),result=[];
    for(let i=0;i<parts.length;i++){
      try{result.push(decoder.decode(new Uint8Array(parts[i]),{stream:i<parts.length-1}))}catch(error){result.push(error.name)}
    }
    result.push(decoder.decode(new Uint8Array([67])));rows.push(result);
  }
}
const backing=new Uint8Array([255,65,0,66,255]);
rows.push(new TextDecoder().decode(new DataView(backing.buffer,1,3)));
rows.push(new TextDecoder('windows-1252').decode(new Uint8Array([65,128,255])));
// Compare malformed boundaries and state reuse, including entry into the fast path
// after a final decode or fatal failure. Keep deterministic bytes for reproduction.
const byteCases=Array.from({length:256},(_,i)=>[i]);
for(const lead of [0xc0,0xc2,0xdf,0xe0,0xed,0xef,0xf0,0xf4,0xf5]){
  for(const next of [0,65,0x7f,0x80,0x8f,0x90,0x9f,0xa0,0xbf,0xc0,0xff]){
    byteCases.push([lead,next],[lead,next,0x80],[lead,next,0x80,0x80]);
  }
}
byteCases.push([239,187,191,65],[65,239,187,191],[226,130,172,65]);
for(const fatal of [false,true])for(const ignoreBOM of [false,true]){
  const decoder=new TextDecoder('utf-8',{fatal,ignoreBOM});
  for(const bytes of byteCases){
    const result=[];
    try{result.push(decoder.decode(new Uint8Array(bytes)))}catch(error){result.push(error.name)}
    result.push(decoder.decode(new Uint8Array([65,0,127])));
    for(let split=0;split<=bytes.length;split++){
      try{
        result.push(decoder.decode(new Uint8Array(bytes.slice(0,split)),{stream:true}));
        result.push(decoder.decode(new Uint8Array(bytes.slice(split))));
      }catch(error){
        result.push(error.name);
        try{decoder.decode()}catch{}
      }
    }
    rows.push(result);
  }
}
return JSON.stringify(rows);
`
const reference=new Function('TextEncoder','TextDecoder','sha',exercise)(TextEncoder,TextDecoder,(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'))

test('guest text encoding matches native ASCII, Unicode and stream boundaries',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async exercise=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/probe.mjs':`import {createHash} from 'node:crypto';const sha=bytes=>createHash('sha256').update(bytes).digest('hex');console.log((function(){${exercise}})());`},{cooperative:true})
    try{return await kernel.runModule('/probe.mjs',{guestWasm:true,webAPIs:true,timeoutMs:30000})}finally{kernel.close()}
  },exercise)
  await info.attach('text-encoding.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe(reference)
})
