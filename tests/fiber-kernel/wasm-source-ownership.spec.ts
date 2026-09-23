import {test,expect} from '@playwright/test'
import {runInNewContext} from 'node:vm'

// One page of private memory, a mutable i32 global initialized to 7, and answer().
const section=(id:number,bytes:number[])=>[id,bytes.length,...bytes]
const name=(value:string)=>[value.length,...Array.from(value,char=>char.charCodeAt(0))]
const bytes=[0,97,115,109,1,0,0,0,
  ...section(1,[1,96,0,1,127]),
  ...section(3,[1,0]),
  ...section(5,[1,0,1]),
  ...section(6,[1,127,1,65,7,11]),
  ...section(7,[3,...name('memory'),2,0,...name('counter'),3,0,...name('answer'),0,0]),
  ...section(10,[1,4,0,65,42,11]),
]
const cases=[
  {name:'Module keeps an immutable copy of its original input',code:`
    const input=new Uint8Array(bytes);
    const module=new WebAssembly.Module(input);
    input.fill(0);
    const a=new WebAssembly.Instance(module).exports;
    const b=new WebAssembly.Instance(module).exports;
    return {answers:[a.answer(),b.answer()],counter:a.counter.value,memory:a.memory.buffer.byteLength};
  `},
  {name:'instances from one Module have independent memory and globals',code:`
    const module=new WebAssembly.Module(new Uint8Array(bytes));
    const a=new WebAssembly.Instance(module).exports;
    const b=new WebAssembly.Instance(module).exports;
    new Uint8Array(a.memory.buffer)[0]=19;a.counter.value=23;
    const before=[new Uint8Array(b.memory.buffer)[0],b.counter.value];
    new Uint8Array(b.memory.buffer)[0]=31;b.counter.value=37;
    return {before,a:[new Uint8Array(a.memory.buffer)[0],a.counter.value],b:[new Uint8Array(b.memory.buffer)[0],b.counter.value]};
  `},
  {name:'instance remains usable after its Module reference is dropped',code:`
    let module=new WebAssembly.Module(new Uint8Array(bytes));
    const instance=new WebAssembly.Instance(module);module=null;
    if(typeof globalThis.gc==='function')globalThis.gc();
    instance.exports.counter.value=17;
    new Uint8Array(instance.exports.memory.buffer)[0]=29;
    return {answer:instance.exports.answer(),counter:instance.exports.counter.value,byte:new Uint8Array(instance.exports.memory.buffer)[0]};
  `},
  {name:'Module can create a fresh instance after a previous instance reference is dropped',code:`
    const module=new WebAssembly.Module(new Uint8Array(bytes));
    let instance=new WebAssembly.Instance(module);
    instance.exports.counter.value=71;new Uint8Array(instance.exports.memory.buffer)[0]=73;
    instance=null;
    if(typeof globalThis.gc==='function')globalThis.gc();
    const fresh=new WebAssembly.Instance(module).exports;
    return {answer:fresh.answer(),counter:fresh.counter.value,byte:new Uint8Array(fresh.memory.buffer)[0]};
  `},
  {name:'Module remains reusable after an import binding failure',code:`
    const imported=new Uint8Array([0,97,115,109,1,0,0,0,
      1,5,1,96,0,1,127,
      2,10,1,4,104,111,115,116,1,102,0,0,
      7,10,1,6,97,110,115,119,101,114,0,0]);
    const module=new WebAssembly.Module(imported);
    let failed=false;
    try{new WebAssembly.Instance(module,{host:{f:0}})}catch(error){failed=error instanceof WebAssembly.LinkError}
    const a=new WebAssembly.Instance(module,{host:{f:()=>42}});
    const b=new WebAssembly.Instance(module,{host:{f:()=>17}});
    return {failed,answers:[a.exports.answer(),b.exports.answer()]};
  `},
  ...['subarray','DataView','Uint16Array'].map(kind=>({name:`Module and validate match native ${kind} byte range behavior`,code:`
    const moduleBytes=bytes.slice();
    // An empty-name custom section adds three bytes when even length is needed.
    if(moduleBytes.length%2)moduleBytes.push(0,1,0);
    const storage=new Uint8Array(moduleBytes.length+8);storage.fill(255);storage.set(moduleBytes,4);
    const input=${kind==='subarray'?'storage.subarray(4,4+moduleBytes.length)':kind==='DataView'?'new DataView(storage.buffer,4,moduleBytes.length)':'new Uint16Array(storage.buffer,4,moduleBytes.length/2)'};
    const result={wholeBufferValid:WebAssembly.validate(storage.buffer)};
    try{result.valid=WebAssembly.validate(input)}catch(error){result.valid=error.name}
    try{result.answer=new WebAssembly.Instance(new WebAssembly.Module(input)).exports.answer()}catch(error){result.answer=error.name}
    return result;
  `})),
  ...['Uint8Array','DataView','ArrayBuffer'].map(kind=>({name:`Module and validate ignore shadow properties on ${kind}`,code:`
    const storage=new Uint8Array(bytes.length+8);storage.set(bytes,4);
    const input=${kind==='Uint8Array'?'storage.subarray(4,4+bytes.length)':kind==='DataView'?'new DataView(storage.buffer,4,bytes.length)':'new Uint8Array(bytes).buffer'};
    let getterCalls=0;
    for(const name of ['buffer','byteOffset','byteLength'])Object.defineProperty(input,name,{get(){getterCalls++;throw Error('shadow property read')}});
    const result={};
    try{result.valid=WebAssembly.validate(input)}catch(error){result.valid=error.name}
    try{result.answer=new WebAssembly.Instance(new WebAssembly.Module(input)).exports.answer()}catch(error){result.answer=error.name}
    return {...result,getterCalls};
  `})),
  {name:'Module and validate reject non-BufferSource input types',code:`
    const inputs=[null,undefined,42,'wasm',{},bytes,{buffer:new Uint8Array(bytes).buffer,byteOffset:0,byteLength:bytes.length}];
    return inputs.map(input=>{
      const row={};
      for(const operation of ['Module','validate'])try{
        row[operation]=operation==='Module'?new WebAssembly.Module(input):WebAssembly.validate(input);
      }catch(error){row[operation]=error.name}
      return row;
    });
  `},
  {name:'Module and validate reject detached input when transfer is available',optionalTransfer:true,code:`
    if(typeof ArrayBuffer.prototype.transfer!=='function')return {supported:false};
    const rows=[];
    for(const kind of ['buffer','typed','view']){
      const buffer=new ArrayBuffer(bytes.length);new Uint8Array(buffer).set(bytes);
      const input=kind==='buffer'?buffer:kind==='typed'?new Uint8Array(buffer):new DataView(buffer);
      buffer.transfer();const row={kind};
      for(const operation of ['Module','validate'])try{
        row[operation]=operation==='Module'?new WebAssembly.Module(input):WebAssembly.validate(input);
      }catch(error){row[operation]=error.name}
      rows.push(row);
    }
    return {supported:true,rows};
  `},
]

for(const fixture of cases)test(fixture.name,async({page},info)=>{
  const code=`(()=>{${fixture.code}})()`
  const expected=JSON.parse(JSON.stringify(runInNewContext(code,{bytes,WebAssembly,Uint8Array},{timeout:1000})))
  await page.goto('/sandbox.html')
  const browserNative=await page.evaluate(({bytes,code})=>{
    try{return {value:new Function('bytes',`return ${code}`)(bytes)}}
    catch(error){return {error:{name:error instanceof Error?error.name:'ThrownValue',message:error instanceof Error?error.message:String(error)}}}
  },{bytes,code})
  const result=await page.evaluate(async({bytes,code})=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true})
    try{return await kernel.execute(`const bytes=${JSON.stringify(bytes)};console.log(JSON.stringify({gcSupported:typeof globalThis.gc==='function',value:${code}}));`,{guestWasm:true,maxBytes:16*1024*1024,timeoutMs:3000})}
    finally{kernel.close()}
  },{bytes,code})
  await info.attach('source-ownership.json',{body:JSON.stringify({expected,browserNative,result,scope:'Reference lifetime and immutable source ownership. Collection is requested only when a guest gc function exists; dropping a reference alone does not prove collection.'}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const actual=JSON.parse(result.stdout).value
  if('optionalTransfer' in fixture)test.skip(!actual.supported||!expected.supported,'ArrayBuffer.transfer unavailable in guest or native reference')
  expect(actual).toEqual(expected)
})
