import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

test.beforeEach(async({},info)=>{
  if(process.env.TERMINATION_COOPERATIVE==='1'){
    const path='public/quickjs-als-asyncify-wasm-o2-generator-queue-yield-profile-poll4096-cooperative'+(process.env.COOPERATIVE_WASM_BATCH?'-batch'+process.env.COOPERATIVE_WASM_BATCH:'')+(process.env.COOPERATIVE_ASSIGNMENTS==='1'?'-assignments':'')+'/build.json'
    await info.attach('parser-engine.json',{body:readFileSync(path),contentType:'application/json'})
  }
})

for(const count of [64,128,256,512])test(`CommonJS parser handles ${count} chained assignments`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async count=>{
    const chain=Array.from({length:count},(_,i)=>'exports.k'+i).join(' = ')+' = 42;'
    const kernel=new window.sandboxLab.WorkerKernel({'/chain.cjs':chain,'/probe.mjs':`import value from './chain.cjs';console.log(JSON.stringify({count:Object.keys(value).length,valid:Object.values(value).every(x=>x===42)}))`},{cooperative:true})
    try{return await kernel.runModule('/probe.mjs',{guestWasm:true,diagnostics:true})}
    finally{kernel.close()}
  },count)
  await info.attach('assignment-chain.json',{body:JSON.stringify({count,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({count,valid:true})
})

const cases=[
  `let events=[];const o={set x(v){events.push(v)}};function ref(n){events.push(n);return o}const value=ref('left').x=ref('right').x=42;return {events,value}`,
  `let a=1,b=3;const value=a+=b*=2;return {a,b,value}`,
  `let a,b;a=b=function(){};return [a.name,b.name]`,
  `let a,b;a=b=class{};return [a.name,b.name]`,
  `let a=0,b,c;a ||= b=c=42;return [a,b,c]`,
  `let a,b;const value=a=({x:b}={x:42});return [a,b,value]`,
  `let a,b;const value=a=b=(()=>{return 42})();return [a,b,value]`,
  `let a=1,b=2;try{a=b=(()=>{throw Error('stop')})()}catch(e){}return [a,b]`,
  `let caught=false;try{eval('let a,b;a=b=;')}catch(e){caught=e instanceof SyntaxError}let a,b;return [caught,a=b=42,a,b]`,
  `let a,b;a=b=()=>42;return [a.name,b.name,a()]`,
  `let a,b;a=b=async()=>42;return [a.name,b.name]`,
  `let a,b;a=b=function*(){};return [a.name,b.name]`,
  `function* f(){let a,b;a=b=yield 7;return [a,b]}const g=f();return [g.next(),g.next(42)]`,
  `let a,b;const x=a=b=true?42:7;return [a,b,x]`,
  `let a,b;const x=a=b=(3,42);return [a,b,x]`,
  `let a=0,b=0,c=1;const x=a=b ||= c+=41;return [a,b,c,x]`,
  `let a,b=null,c;const x=a=b??=c=42;return [a,b,c,x]`,
  `let a,b=1,c;const x=a=b&&=c=42;return [a,b,c,x]`,
  `let a,b;[a,b]=[1,2];a=b=({x:42}).x;return [a,b]`,
  `let events=[];const o={get x(){events.push('get');return 2},set x(v){events.push(v)}};let a=1;const result=a+=o.x*=3;return [events,a,result]`,
  `class C{#x=1;run(){let a;return a=this.#x=42}}return new C().run()`,
  `class B{set x(v){this.value=v}}class C extends B{run(){let a;return a=super.x=42}}const c=new C;return [c.run(),c.value]`,
  `let a=1;const b=2;let error;try{a=b=42}catch(e){error=e.name}return [a,b,error]`,
  ...['*=','/=','%=','+=','-=','<<=','>>=','>>>=','&=','^=','|=','**='].map(op=>`let a=4,b=2;const result=a${op}b=3;return [a,b,result]`),
]
test('assignment parser preserves Node evaluation semantics',async({page},info)=>{
  const reference=cases.map(source=>new Function(source)())
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async cases=>{
    const source='console.log(JSON.stringify(['+cases.map(code=>'(()=>{'+code+'})()').join(',')+']))'
    const kernel=new window.sandboxLab.WorkerKernel({'/probe.cjs':source},{cooperative:true})
    try{return await kernel.runModule('/probe.cjs',{guestWasm:true})}finally{kernel.close()}
  },cases)
  await info.attach('assignment-semantics.json',{body:JSON.stringify({reference,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(reference)
})
