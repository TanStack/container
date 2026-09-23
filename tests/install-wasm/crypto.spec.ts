import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
const source=`import crypto,{timingSafeEqual} from 'node:crypto';
const results=[];const check=(name,a,b)=>{try{results.push([name,timingSafeEqual(a,b)])}catch(e){results.push([name,e.name,e.code])}};
check('empty',new ArrayBuffer(0),new Uint8Array(0));
check('same',Buffer.from([1,2,3]),Buffer.from([1,2,3]));
for(let i=0;i<128;i++){const a=Buffer.alloc(128,7),b=Buffer.from(a);b[i]=8;check('different '+i,a,b)}
check('view',new DataView(new Uint8Array([9,1,2,8]).buffer,1,2),new Uint8Array([1,2]));
check('offset',new Uint8Array([9,1,2,8]).subarray(1,3),new Uint8Array([1,2]));
check('float bytes',new Float64Array([0]),new Float64Array([-0]));
check('length',Buffer.alloc(1),Buffer.alloc(2));
for(const value of [undefined,null,1,'abc',{},[],new Proxy(new Uint8Array(0),{})])check('invalid',value,new Uint8Array(0));
const spoof=new Uint8Array([1,2]);Object.defineProperty(spoof,'byteLength',{get(){throw Error('getter called')}});Object.defineProperty(spoof,'buffer',{get(){throw Error('getter called')}});check('no getters',spoof,new Uint8Array([1,2]));
const detached=new ArrayBuffer(4);const detachedView=new Uint8Array(detached);detached.transfer();check('detached',detached,new Uint8Array(0));check('detached view',detachedView,new Uint8Array(0));
const rab=new ArrayBuffer(8,{maxByteLength:16});const tracked=new Uint16Array(rab,2);const fixed=new Uint16Array(rab,2,2);rab.resize(3);check('tracked',tracked,new Uint8Array(0));check('out of bounds',fixed,new Uint8Array(0));rab.resize(12);check('regrown',tracked,new Uint8Array(10));
results.push(['default export',crypto.timingSafeEqual===timingSafeEqual]);console.log(JSON.stringify(results));`
for(const guestWasm of [false,true])test(`native byte equality matches Node (${guestWasm?'WASM bridge':'default'})`,async({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/test.mjs':source})
    try{return await kernel.runModule('/test.mjs',{guestWasm})}finally{kernel.close()}
  },{source,guestWasm})
  await info.attach('crypto.json',{body:JSON.stringify({node:node.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(node.stdout))
})

const entropySource=`import crypto,{webcrypto} from 'node:crypto';
const results=[];const check=(name,fn)=>{try{results.push([name,fn()])}catch(e){results.push([name,e.name,e.code])}};
check('export identity',()=>crypto.webcrypto===webcrypto);
for(const C of [Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,BigInt64Array,BigUint64Array])check(C.name,()=>{const a=new C(8);return webcrypto.getRandomValues(a)===a});
check('empty',()=>webcrypto.getRandomValues(new Uint8Array(0)).length);
check('maximum',()=>webcrypto.getRandomValues(new Uint8Array(65536)).length);
check('quota',()=>webcrypto.getRandomValues(new Uint8Array(65537)));
check('missing',()=>webcrypto.getRandomValues());
for(const v of [undefined,null,1,'abc',{},[],new Float32Array(1),new Float64Array(1),new DataView(new ArrayBuffer(1)),new Proxy(new Uint8Array(1),{})])check('invalid',()=>webcrypto.getRandomValues(v));
check('receiver',()=>webcrypto.getRandomValues.call({},new Uint8Array(1)));
check('uuid receiver',()=>webcrypto.randomUUID.call({}));
check('uuid',()=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(webcrypto.randomUUID()));
check('offset bounds',()=>{const a=new Uint8Array(258).fill(7);webcrypto.getRandomValues(a.subarray(1,257));return a[0]===7&&a[257]===7&&a.subarray(1,257).some(x=>x!==7)});
check('no getters',()=>{const a=new Uint8Array(4);for(const key of ['buffer','byteOffset','byteLength'])Object.defineProperty(a,key,{get(){throw Error('getter called')}});return webcrypto.getRandomValues(a)===a});
check('detached',()=>{const b=new ArrayBuffer(4),a=new Uint8Array(b);b.transfer();return webcrypto.getRandomValues(a)===a});
console.log(JSON.stringify(results));`
for(const guestWasm of [false,true])test(`Web Crypto entropy matches Node (${guestWasm?'WASM bridge':'default'})`,async({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',entropySource],{encoding:'utf8',timeout:10000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/test.mjs':source})
    try{return await kernel.runModule('/test.mjs',{guestWasm})}finally{kernel.close()}
  },{source:entropySource,guestWasm})
  await info.attach('webcrypto.json',{body:JSON.stringify({node:node.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const actual=JSON.parse(result.stdout),reference=JSON.parse(node.stdout)
  // Explicit difference: preserve intrinsic bounds even when guest properties
  // shadow them. Node currently reads these getters; do not hide that mismatch.
  expect(actual.find((row:unknown[])=>row[0]==='no getters')).toEqual(['no getters',true])
  expect(reference.find((row:unknown[])=>row[0]==='no getters')).toEqual(['no getters','Error',null])
  expect(actual.filter((row:unknown[])=>row[0]!=='no getters')).toEqual(reference.filter((row:unknown[])=>row[0]!=='no getters'))
})
