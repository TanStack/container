import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
const samples=[1,32,256,1024,1800].map(depth=>({depth,bytes:[...readFileSync('public/compiler-depth/loop-'+depth+'.wasm')]}))
const leb=(n:number)=>{const out=[];do{const byte=n&127;n>>>=7;out.push(byte|(n?128:0))}while(n);return out}
const section=(id:number,bytes:number[])=>[id,...leb(bytes.length),...bytes]
const body=[0,...Array.from({length:4097},()=>[3,0x7f]).flat(),0x41,42,...Array(4098).fill(0x0b)]
const overflow=[0,97,115,109,1,0,0,0,...section(1,[1,0x60,0,1,0x7f]),...section(3,[1,0]),...section(7,[1,6,...Buffer.from('answer'),0,0]),...section(10,[1,...leb(body.length),...body])]
// One i32 local counts three loop iterations, each grows memory by one page.
const growthBody=[1,1,0x7f,0x41,3,0x21,0,3,0x40,0x41,1,0x40,0,0x1a,0x20,0,0x41,1,0x6b,0x22,0,0x0d,0,0x0b,0x3f,0,0x0b]
const growth=[0,97,115,109,1,0,0,0,...section(1,[1,0x60,0,1,0x7f]),...section(3,[1,0]),...section(5,[1,1,1,4]),...section(7,[1,6,...Buffer.from('answer'),0,0]),...section(10,[1,...leb(growthBody.length),...growthBody])]
const control=[...readFileSync('public/guest-wasm/control-flow.wasm')]
test('heap loops preserve branch values and refreshed memory after growth',async({page},info)=>{
  expect(process.env.COOPERATIVE_HEAP_LOOPS).toBe('1')
  const source=`const c=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(control)}))).exports;
  const g=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(growth)}))).exports;
  const rows=[];for(let i=1;i<=20;i++)rows.push([c.sum(i),c.loopParameter(i),c.branch(i%2),c.choose(i%2),c.passthrough(i,1),c.nestedElse(i%2,(i+1)%2)]);
  rows.push([g.answer(),g.answer()]);JSON.stringify(rows);`
  const reference=runInNewContext(source,{WebAssembly},{timeout:5000})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({}, {cooperative:true})
    try{return await kernel.execute('console.log(eval('+JSON.stringify(source)+'))',{guestWasm:true})}finally{kernel.close()}
  },source)
  await info.attach('loop-control-memory.json',{body:JSON.stringify({reference,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe(reference)
})
test('heap loop continuations survive repeated deep entry and return',async({page},info)=>{
  expect(process.env.COOPERATIVE_HEAP_LOOPS).toBe('1')
  const reference=samples.map(({bytes})=>{
    const instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)))
    return (instance.exports.answer as ()=>number)()
  })
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async samples=>{
    const kernel=new window.sandboxLab.WorkerKernel({}, {cooperative:true})
    try{
      return await kernel.execute(`const samples=${JSON.stringify(samples)};const results=[];
      for(const sample of samples){const instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(sample.bytes)));let answer;
        for(let i=0;i<100;i++){answer=instance.exports.answer();if(answer!==42)throw Error('Incorrect loop result')}
        results.push(answer)}console.log(JSON.stringify(results));`,{guestWasm:true,timeoutMs:30000})
    }finally{kernel.close()}
  },samples)
  await info.attach('heap-loop-repeat.json',{body:JSON.stringify({reference,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(reference)
})

test('loop continuation limit traps repeatedly and restores its quota',async({page},info)=>{
  expect(process.env.COOPERATIVE_HEAP_LOOPS).toBe('1')
  expect(WebAssembly.validate(new Uint8Array(overflow))).toBe(true)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({overflow,recovery})=>{
    const kernel=new window.sandboxLab.WorkerKernel({}, {cooperative:true})
    try{return await kernel.execute(`const large=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(overflow)})));
      const small=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(recovery)})));
      for(let i=0;i<20;i++){let trapped=false;try{large.exports.answer()}catch(e){if(!(e instanceof WebAssembly.RuntimeError))throw e;trapped=true}
        if(!trapped)throw Error('Missing loop quota');if(small.exports.answer()!==42)throw Error('Failed recovery')}
      console.log('20 recovered');`,{guestWasm:true,timeoutMs:30000})}finally{kernel.close()}
  },{overflow,recovery:samples.at(-1)!.bytes})
  await info.attach('loop-quota-recovery.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('20 recovered\n')
})
