import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {test} from 'node:test'

const baselineRoot=resolve(process.env.INTERPRETER_PROPERTY_BASELINE_ENGINE??'public/quickjs-als-asyncify-wasm-o2-atomics-assignments-fibers-shared-storage-simd-lazy-wasm-compiled-initializers-iterative-calls-module-import-exports')
const baselineSHA256=process.env.INTERPRETER_PROPERTY_BASELINE_SHA256??'7081157bdf7c45af7b18fc7981c5746a032f7c29791993a953a5d43eb2991bd0'
const roots=[baselineRoot]
if(process.env.INTERPRETER_PROPERTY_SPLIT_ENGINE)roots.push(resolve(process.env.INTERPRETER_PROPERTY_SPLIT_ENGINE))

function sha256(bytes){return createHash('sha256').update(bytes).digest('hex')}

async function openEngine(root){
  const wasm=readFileSync(join(root,'engine.wasm'))
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({
    type:'async',
    importFFI:async()=>QuickJSAsyncFFI,
    importModuleLoader:async()=>async()=>factory({wasmBinary:wasm}),
  })
  return {engine,wasmSHA256:sha256(wasm)}
}

function unwrap(context,result){
  if(result.error){
    const error=context.dump(result.error)
    result.dispose()
    throw Error(JSON.stringify(error))
  }
  return result.value
}

function synchronousFixture(){
  return `(()=>{
    const field={value:2};field.value+=3;const fieldResult=field.value;
    const array=[1,2];array[1]=array[0]+4;array.push(8);const arrayResult=[array[1],array.length,[...array].join(':')];
    let reference=3;const referenceResult=[reference++,++reference,reference];
    class PrivateState{#value=4;#double(){return this.#value*2}read(){return this.#double()}write(value){this.#value=value;return this.#value}}
    const privateState=new PrivateState();const privateResult=[privateState.read(),privateState.write(7),privateState.read()];
    class Base{get score(){return this._score??6}set score(value){this._score=value+1}}
    class Child extends Base{read(){return super.score}write(value){super.score=value;return this._score}}
    const child=new Child();const superResult=[child.read(),child.write(9),child.read()];
    const events=[];const target={value:10};const proxy=new Proxy(target,{get(object,key){events.push('get:'+String(key));return Reflect.get(object,key)},set(object,key,value){events.push('set:'+String(key));return Reflect.set(object,key,value)}});
    proxy.value+=5;const proxyResult=[proxy.value,events];
    const copied={prefix:1,...{field:2},suffix:3};const appended=[0,...array,9];
    return {fieldResult,arrayResult,referenceResult,privateResult,superResult,proxyResult,copied,appended};
  })()`
}

const suspendedCases=[
  {
    name:'field getter resumes',
    source:`()=>{const object={get value(){const value=park();return value+2}};return object.value}`,
    expected:42,
  },
  {
    name:'private method resumes',
    source:`()=>{class Box{#read(){return park()+3}value(){return this.#read()}}return new Box().value()}`,
    expected:43,
  },
  {
    name:'array proxy getter resumes',
    source:`()=>{const array=new Proxy([2],{get(target,key){if(key==='0')return park()+4;return Reflect.get(target,key)}});return array[0]}`,
    expected:44,
  },
  {
    name:'super getter resumes',
    source:`()=>{class Base{get value(){return park()+5}}class Child extends Base{read(){return super.value}}return new Child().read()}`,
    expected:45,
  },
  {
    name:'proxy getter resumes',
    source:`()=>new Proxy({},{get(){return park()+6}}).value`,
    expected:46,
  },
  {
    name:'reference update resumes',
    source:`()=>{const object={get value(){return park()},set value(next){globalThis.referenceWrite=next}};object.value+=7;return referenceWrite}`,
    expected:47,
  },
  {
    name:'field setter resumes before writeback',
    source:`()=>{const object={set value(next){const offset=park();globalThis.setterWrite=next+offset}};object.value=2;return setterWrite}`,
    expected:42,
  },
  {
    name:'object spread getter resumes during partial copy',
    source:`()=>{const source={get value(){return park()},tail:2};return {prefix:1,...source,suffix:3}}`,
    expected:{prefix:1,value:40,tail:2,suffix:3},
  },
  {
    name:'getter throws after resume',
    source:`()=>{const events=[];const object={get value(){events.push('get');park();throw Error('getter boom')}};try{object.value}catch(error){events.push(error.message)}finally{events.push('finally')}return events.join(':')}`,
    expected:'get:getter boom:finally',
  },
  {
    name:'proxy trap throws after resume',
    source:`()=>{const events=[];const proxy=new Proxy({},{get(){events.push('trap');park();throw Error('proxy boom')}});try{proxy.value}catch(error){events.push(error.message)}return events.join(':')}`,
    expected:'trap:proxy boom',
  },
  {
    name:'ALS survives getter suspension',
    source:`()=>als.run('property-scope',()=>{const object={get value(){park();return als.getStore()}};return object.value})`,
    expected:'property-scope',
  },
  {
    name:'deep getter suspension unwinds',
    source:`()=>{function deep(n,object){return n?1+deep(n-1,object):object.value}const object={get value(){return park()}};return deep(500,object)}`,
    expected:540,
  },
]

for(const root of roots)test(`interpreter property split preserves semantics: ${root}`,async t=>{
  const {engine,wasmSHA256}=await openEngine(root)
  if(root===baselineRoot)assert.equal(wasmSHA256,baselineSHA256,'baseline engine identity changed')
  t.diagnostic(JSON.stringify({root,wasmSHA256,role:root===baselineRoot?'baseline':'candidate'}))
  const runtime=engine.newRuntime(),context=runtime.newContext()
  runtime.setMemoryLimit(64*1024*1024)
  runtime.setMaxStackSize(1024*1024)
  const deadline=Date.now()+20_000
  runtime.setInterruptHandler(()=>Date.now()>deadline)
  const evaluate=source=>unwrap(context,context.evalCode(source))
  try{
    const synchronous=evaluate(synchronousFixture())
    try{
      assert.deepEqual(context.dump(synchronous),{
        fieldResult:5,
        arrayResult:[5,3,'1:5:8'],
        referenceResult:[3,5,5],
        privateResult:[8,7,14],
        superResult:[6,10,10],
        proxyResult:[15,['get:value','set:value','get:value']],
        copied:{prefix:1,field:2,suffix:3},
        appended:[0,1,5,8,9],
      })
    }finally{synchronous.dispose()}

    evaluate(readFileSync('src/sandbox/engine-als-bootstrap.js','utf8')).dispose()
    const initializer=evaluate('park=>{globalThis.park=park;globalThis.als=new __engineAsyncLocalStorage()}')
    unwrap(context,context.initializeFiber(initializer)).dispose()
    initializer.dispose()

    for(const fixture of suspendedCases){
      const fn=evaluate(fixture.source)
      const fiber=context.startFiberCall(fn)
      fn.dispose()
      try{
        assert.equal(fiber.step(),1,`${fixture.name} must park`)
        assert.equal(fiber.deliver(40),true,`${fixture.name} must accept resume value`)
        assert.equal(fiber.step(),2,`${fixture.name} must finish after resume`)
        const result=fiber.takeResult()
        try{
          assert.ok(result.value,`${fixture.name} returned a guest error: ${result.error?JSON.stringify(context.dump(result.error)):''}`)
          assert.deepEqual(context.dump(result.value),fixture.expected,fixture.name)
        }finally{result.dispose()}
      }finally{
        if(fiber.status()!==2){fiber.cancel();fiber.step();if(fiber.status()===2)fiber.takeResult().dispose()}
        fiber.dispose()
      }
    }

    evaluate(`globalThis.cancellationEvents=[]`).dispose()
    const cancelledFunction=evaluate(`()=>{const object={get value(){cancellationEvents.push('before');park();cancellationEvents.push('after');return 1}};return object.value}`)
    const cancelled=context.startFiberCall(cancelledFunction)
    cancelledFunction.dispose()
    try{
      assert.equal(cancelled.step(),1,'property getter cancellation must park')
      assert.equal(cancelled.cancel(),true,'parked property getter must accept cancellation')
      assert.equal(cancelled.step(),2,'cancelled property getter must unwind')
      const result=cancelled.takeResult()
      try{
        assert.ok(result.error)
        assert.match(context.dump(result.error).message,/cancelled/)
      }finally{result.dispose()}
    }finally{cancelled.dispose()}
    const cancellationEvents=evaluate('cancellationEvents')
    try{assert.deepEqual(context.dump(cancellationEvents),['before'])}finally{cancellationEvents.dispose()}

    const recoveryFunction=evaluate(`()=>{const object={get value(){return park()+2}};return object.value}`)
    const recoveryFiber=context.startFiberCall(recoveryFunction)
    recoveryFunction.dispose()
    try{
      assert.equal(recoveryFiber.step(),1)
      assert.equal(recoveryFiber.deliver(40),true)
      assert.equal(recoveryFiber.step(),2)
      const result=recoveryFiber.takeResult()
      try{assert.equal(context.getNumber(unwrap(context,result)),42)}finally{result.dispose()}
    }finally{recoveryFiber.dispose()}

    const uncaught=evaluate(`()=>{const object={get value(){park();throw Error('owned property error')}};return object.value}`)
    const fiber=context.startFiberCall(uncaught)
    uncaught.dispose()
    try{
      assert.equal(fiber.step(),1)
      assert.equal(fiber.deliver(40),true)
      assert.equal(fiber.step(),2)
      const result=fiber.takeResult()
      try{
        assert.ok(result.error)
        assert.equal(context.dump(result.error).message,'owned property error')
      }finally{result.dispose()}
    }finally{fiber.dispose()}

    const recovered=evaluate('6*7')
    try{assert.equal(context.getNumber(recovered),42)}finally{recovered.dispose()}
  }finally{
    context.dispose()
    runtime.dispose()
  }
})
