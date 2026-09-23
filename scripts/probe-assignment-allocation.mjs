import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import ASYNCIFY from '@jitl/quickjs-wasmfile-release-asyncify'

const directory='quickjs-als-asyncify-wasm-o2-generator-queue-yield-profile-poll4096-cooperative-batch16-assignments'
const core=await import('../public/'+directory+'/core.mjs')
const {default:loader}=await import('../public/'+directory+'/engine.mjs')
const {QuickJSAsyncFFI}=await import('../public/'+directory+'/ffi.mjs')
const build=JSON.parse(readFileSync('public/'+directory+'/build.json','utf8'))
assert.ok(build.assignmentParser)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant(core.newVariant({
  ...ASYNCIFY,importModuleLoader:async()=>loader,importFFI:async()=>QuickJSAsyncFFI,
},{wasmBinary:readFileSync('public/'+directory+'/engine.wasm')}))
const lhs=Array.from({length:512},(_,i)=>'o.p'+i).join('=')
const source='(function(o){'+lhs+'=42;return o.p0})'
const malformed='(function(o){'+lhs+'=;})'
let failures=0,successes=0,recoveries=0
for(let headroom=0;headroom<=524288;headroom+=4096){
  const runtime=engine.newRuntime(),context=runtime.newContext()
  try{
    const usage=runtime.computeMemoryUsage()
    const used=context.dump(usage).malloc_size
    usage.dispose()
    runtime.setMemoryLimit(used+headroom)
    const attempted=context.evalCode(source,'assignment.js')
    runtime.setMemoryLimit(32*1024*1024)
    if(attempted.error)failures++;else successes++
    attempted.dispose()
    // Exercise atom/frame cleanup for a syntax error after all LHS frames exist.
    const invalid=context.evalCode(malformed,'invalid.js')
    assert.ok(invalid.error,'Malformed chain must fail')
    invalid.dispose()
    const fn=context.unwrapResult(context.evalCode(source,'recovery.js'))
    const object=context.newObject()
    try{
      const result=context.unwrapResult(context.callFunction(fn,context.undefined,object))
      try{assert.equal(context.dump(result),42)}finally{result.dispose()}
      recoveries++
    }finally{object.dispose();fn.dispose()}
  }finally{
    runtime.setMemoryLimit(32*1024*1024)
    context.dispose();runtime.dispose()
  }
}
assert.ok(failures>0&&successes>0,'Sweep must include failures and successes')
const result={scope:'Candidate WASM hosted in Node, memory-limit sweep and same-runtime parse recovery; not native sanitizer or exhaustive allocation-site coverage',build,failures,successes,recoveries}
writeFileSync('reports/assignment-parser-allocation.json',JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({failures,successes,recoveries}))
