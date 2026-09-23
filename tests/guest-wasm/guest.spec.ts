import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {guestWasmCases} from '../../fixtures/guest-wasm-cases.mjs'
const control=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/controls.wasm'))
const md4=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/webpack-md4.wasm'))
const prelude=`const control=new Uint8Array(${JSON.stringify([...control])});const md4=new Uint8Array(${JSON.stringify([...md4])});`

for(const fixture of guestWasmCases)test(fixture.name,async({page},info)=>{
  const expected=runInNewContext(fixture.code,{control,md4,WebAssembly},{timeout:3000})
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async code=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{return await kernel.execute(code,{guestWasm:true})}finally{kernel.close()}
  },prelude+`console.log(eval(${JSON.stringify(fixture.code)}));`)
  await info.attach('guest-wasm.json',{body:JSON.stringify({name:fixture.name,result,expected}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(expected+'\n')
})

test('default Webpack builds, edits, repeats and restores inside the guest',async({page},info)=>{
  await page.goto('/sandbox.html')
  const report=await page.evaluate(()=>window.sandboxLab.runWorkload('webpack',undefined,{guestWasm:true}))
  await info.attach('webpack.json',{body:JSON.stringify(report),contentType:'application/json'})
  expect(report.status,report.error).toBe('pass')
  expect(report.iterations).toHaveLength(4)
})

test('guest WASM deadlines, aggregate allocations and recovery',async({page},info)=>{
  const imported=[...readFileSync('public/wasm-interpreter-probe/imports.wasm')]
  const start=[...readFileSync('public/wasm-interpreter-probe/start-loop.wasm')]
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async({prelude,imported,start})=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    const run=(code:string,options={})=>kernel.execute(prelude+code,{guestWasm:true,...options})
    try{
      const denied=await run(`try{new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(imported)})),{host:{}})}catch(e){console.log(e.name,e instanceof WebAssembly.LinkError)}`)
      const loop=await run(`new WebAssembly.Instance(new WebAssembly.Module(control)).exports.loop()`,{timeoutMs:100})
      const startLoop=await run(`new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(start)})))`,{timeoutMs:100})
      const retained=await run(`const m=new WebAssembly.Module(control),keep=[];console.log('begin');for(let i=0;i<32;i++){const instance=new WebAssembly.Instance(m);instance.exports.memory.grow(32);keep.push(instance)}console.log('escaped');`)
      const mixed=await run(`const js=new Uint8Array(10*1024*1024);const e=new WebAssembly.Instance(new WebAssembly.Module(control)).exports;let error;try{e.memory.grow(128)}catch(e){error=e.name};console.log(error,js.length,e.memory.buffer.byteLength);`)
      const recovery=await run(`console.log(new WebAssembly.Instance(new WebAssembly.Module(control)).exports.answer())`)
      return {denied,loop,startLoop,retained,mixed,recovery}
    }finally{kernel.close()}
  },{prelude,imported,start})
  await info.attach('guest-wasm-limits.json',{body:JSON.stringify(results),contentType:'application/json'})
  expect(results.denied.stdout).toBe('LinkError true\n')
  for(const result of [results.loop,results.startLoop,results.retained])expect(result.exitCode,result.stdout).not.toBe(0)
  expect(results.retained.stdout).toBe('begin\n')
  expect(results.mixed.exitCode,results.mixed.stderr).toBe(0)
  expect(results.mixed.stdout).toBe('RangeError 10485760 65536\n')
  expect(results.recovery.stdout).toBe('42\n')
})

test('guest callbacks retain ALS through asynchronous instantiation and microtasks',async({page},info)=>{
  const bytes=[...readFileSync('public/guest-wasm/callback.wasm')]
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async bytes=>{
    const source=`import {AsyncLocalStorage} from 'node:async_hooks';
      const als=new AsyncLocalStorage(),calls=[],later=[];
      const bytes=new Uint8Array(${JSON.stringify(bytes)});
      const module=await WebAssembly.compile(bytes);
      const rows=await Promise.all(['a','b'].map(store=>als.run(store,async()=>{
        await 0;
        const instance=await WebAssembly.instantiate(module,{host:{callback:n=>{
          calls.push(als.getStore());queueMicrotask(()=>later.push(als.getStore()));return n;
        }}});
        const answer=instance.exports.call(3);await 0;return [store,answer,als.getStore()];
      })));
      console.log(JSON.stringify({rows,calls,later,outer:als.getStore()??null}));`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true})}finally{kernel.close()}
  },bytes)
  await info.attach('callback-als.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({rows:[['a',6,'a'],['b',6,'b']],calls:['a','b'],later:['a','b'],outer:null})
})

test('callback deadlines and cross-instance nesting stay bounded and recover',async({page},info)=>{
  const bytes=[...readFileSync('public/guest-wasm/callback.wasm')]
  const start=[...readFileSync('public/guest-wasm/callback-start.wasm')]
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async({bytes,start})=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    const run=(source:string,options={})=>kernel.execute(source,{guestWasm:true,...options})
    const module=`new WebAssembly.Module(new Uint8Array(${JSON.stringify(bytes)}))`
    try{
      const loop=await run(`new WebAssembly.Instance(${module},{host:{callback:()=>{for(;;){}}}}).exports.call(1)`,{timeoutMs:100})
      const startLoop=await run(`new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(start)})),{host:{start:()=>{for(;;){}}}})`,{timeoutMs:100})
      const recursive=await run(`const m=${module};let a,b;a=new WebAssembly.Instance(m,{host:{callback:n=>b.reenter(n)}}).exports;b=new WebAssembly.Instance(m,{host:{callback:n=>a.reenter(n)}}).exports;try{a.reenter(10000)}catch(e){console.log('bounded',e.name)}console.log(a.reenter(3),b.reenter(3));`)
      const recovery=await run('console.log(42)')
      return {loop,startLoop,recursive,recovery}
    }finally{kernel.close()}
  },{bytes,start})
  await info.attach('callback-limits.json',{body:JSON.stringify(results),contentType:'application/json'})
  for(const result of [results.loop,results.startLoop])expect(result.exitCode,result.stdout).not.toBe(0)
  expect(results.recursive.exitCode,results.recursive.stderr).toBe(0)
  expect(results.recursive.stdout).toBe('bounded RuntimeError\n7 7\n')
  expect(results.recovery.stdout).toBe('42\n')
})

test('callback cycles and surviving buffers fit repeated guest allocation budgets',async({page},info)=>{
  const bytes=[...readFileSync('public/guest-wasm/callback.wasm')]
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async bytes=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{return await kernel.execute(`const bytes=new Uint8Array(${JSON.stringify(bytes)});let count=0;
      for(let round=0;round<20;round++){
        const buffers=[];
        for(let n=0;n<10;n++){
          const box={};const i=new WebAssembly.Instance(new WebAssembly.Module(bytes),{host:{callback:n=>box.instance?n+1:0}});
          box.instance=i;if(i.exports.call(2)!==5)throw Error('callback');
          const b=i.exports.memory.buffer;new Uint8Array(b)[0]=17;buffers.push(b);count++;
        }
        for(const b of buffers)if(new Uint8Array(b)[0]!==17)throw Error('retained buffer');
      }console.log(count);`,{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  },bytes)
  await info.attach('callback-cycles.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('200\n')
})

test('WeakMap object-key cycles are reclaimed while live entries survive',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{return await kernel.execute(`
      const map=new WeakMap(),live={},value={answer:42};map.set(live,value);
      function insert(n){
        const key={};const buffer=new Uint8Array(65536);buffer[0]=n&255;
        map.set(key,{buffer,key,closure:()=>key});
      }
      for(let n=0;n<1024;n++){
        insert(n);
        if(map.get(live)!==value)throw Error('lost live entry');
      }
      console.log(1024,map.get(live).answer);
    `,{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  })
  await info.attach('weakmap-cycles.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('1024 42\n')
})

test('imported memory survives owner collection and repeated allocation pressure',async({page},info)=>{
  const bytes=[...readFileSync('public/guest-wasm/memory-import.wasm')]
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async bytes=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{return await kernel.execute(`const module=new WebAssembly.Module(new Uint8Array(${JSON.stringify(bytes)}));
      function make(){
        const memory=new WebAssembly.Memory({initial:1,maximum:8});
        const a=new WebAssembly.Instance(module,{host:{memory,callback:n=>n}}).exports;
        const b=new WebAssembly.Instance(module,{host:{memory,callback:n=>n}}).exports;
        b.write(0,17);
        return {buffer:memory.buffer,read:a.read};
      }
      const survivingRead=make().read;let count=0;
      for(let round=0;round<20;round++){
        const buffers=[];for(let n=0;n<10;n++){buffers.push(make().buffer);count++}
        for(const buffer of buffers)if(new Uint8Array(buffer)[0]!==17)throw Error('lost memory');
        if(survivingRead(0)!==17)throw Error('lost imported memory');
      }
      let a,b;const memory=new WebAssembly.Memory({initial:1,maximum:8});
      a=new WebAssembly.Instance(module,{host:{memory,callback:n=>b.reenter(n)}}).exports;
      b=new WebAssembly.Instance(module,{host:{memory,callback:n=>a.reenter(n)}}).exports;
      let bounded;try{a.reenter(10000)}catch(e){bounded=e.name}
      console.log(count,survivingRead(0),bounded,a.reenter(3),b.reenter(3));
    `,{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  },bytes)
  await info.attach('imported-memory-lifetime.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe('200 17 RuntimeError 7 7\n')
})
