import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

// Include every one- and two-byte sequence, constrained continuation boundaries,
// random longer sequences, and slices that end midway through valid characters.
const source=`
import {Buffer} from 'node:buffer';import {createHash} from 'node:crypto';
const digest=createHash('sha256');let count=0;
function check(bytes,start=0,end=bytes.length){
  const value=Buffer.from(bytes).toString('utf8',start,end);
  digest.update(JSON.stringify(value)+'\\n');count++;
}
for(let a=0;a<256;a++){check([a]);for(let b=0;b<256;b++)check([a,b])}
const edge=[0,0x7f,0x80,0x8f,0x90,0x9f,0xa0,0xbf,0xc0,0xdf,0xe0,0xed,0xef,0xf0,0xf4,0xf5,0xff];
for(const a of [0xe0,0xe1,0xed,0xef,0xf0,0xf1,0xf4])for(const b of edge)for(const c of edge){check([a,b,c]);for(const d of edge)if(a>=0xf0)check([a,b,c,d])}
let seed=42;for(let i=0;i<5000;i++){const bytes=[];for(let j=0;j<i%17;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;bytes.push(seed>>>24)}check(bytes)}
for(const text of ['aé🦊z','\\ufeffhello','日本語','\\u0000é','𐀀􏿿']){
  const bytes=Array.from(Buffer.from(text));for(let start=0;start<=bytes.length;start++)for(let end=start;end<=bytes.length;end++)check(bytes,start,end);
}
console.log(JSON.stringify({count,sha256:digest.digest('hex')}));
`

for(const webAPIs of [false,true])for(const execution of ['modules','bundle'] as const){
  test('Portable core | '+execution+' | Buffer UTF-8 corpus, web APIs '+webAPIs,async({page})=>{
    const reference=spawnSync(process.execPath,['--input-type=module'],{input:source,encoding:'utf8',timeout:15000})
    expect(reference.status,reference.stderr).toBe(0)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({source,execution,webAPIs})=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':source})
      try{return await (execution==='modules'?kernel.runModule('/entry.mjs',{webAPIs,timeoutMs:10000}):kernel.run('/entry.mjs',{webAPIs,timeoutMs:10000}))}finally{kernel.close()}
    },{source,execution,webAPIs})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(result.stdout).toBe(reference.stdout)
  })
}
