import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'

const root=resolve('public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage-simd-lazy-wasm-compiled-initializers')
const metadata=JSON.parse(readFileSync(join(root,'build.json'),'utf8'))
if(metadata.compiledInitializers?.bindingSHA256!==createHash('sha256').update(readFileSync('src/sandbox/trusted-initializer.c')).digest('hex'))throw Error('Stale initializer bridge')
const core=await import(pathToFileURL(join(root,'core.mjs')).href)
const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>()=>factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})})
const source=readFileSync('public/vm-web-apis/globals.js','utf8')
let bytes
const rows=[]
for(let index=0;index<4;index++){
 const runtime=engine.newRuntime();runtime.setMemoryLimit(128*1024*1024)
 const context=runtime.newContext(),start=performance.now()
 try{
  if(index===0){
   const input=context.newString(source)
   try{
    const compiled=context.unwrapResult(context.compileTrustedInitializer(input))
    try{const view=context.getArrayBuffer(compiled);try{bytes=view.value.slice()}finally{view.dispose()}}finally{compiled.dispose()}
   }finally{input.dispose()}
   const result=context.unwrapResult(context.evalCode('typeof Request'))
   try{if(context.getString(result)!=='undefined')throw Error('Compilation executed source')}finally{result.dispose()}
  }else{
   const input=context.newArrayBuffer(bytes.buffer)
   try{context.unwrapResult(context.evalTrustedInitializer(input)).dispose()}finally{input.dispose()}
   const result=context.unwrapResult(context.evalCode("if(Request.prototype.marker!==undefined)throw Error('shared state');Request.prototype.marker=42;JSON.stringify([Request.name,new URL('https://example.com/?a=42').searchParams.get('a'),typeof globalThis.QTS_EvalTrustedInitializer])"))
   try{if(context.getString(result)!=='["Request","42","undefined"]')throw Error('Unexpected initializer output')}finally{result.dispose()}
  }
  rows.push({index,phase:index===0?'compile-and-copy':'load-and-check',ms:performance.now()-start,passed:true})
 }finally{context.dispose();runtime.dispose()}
}
const report={scope:'Host wrapper integration with same-engine bytes and fresh runtimes, not WorkerKernel startup.',bytes:bytes.length,rows,metadata}
writeFileSync('reports/initializer-wrapper.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({bytes:bytes.length,rows},null,2))
