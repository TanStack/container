import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

// Bounded native-engine diagnostic, no browser server or native rebuild needed.
const bootstrap=readFileSync('src/sandbox/guest-wasm.js','utf8')
const sortDiagnostics=process.argv.includes('--sort-diagnostics')
const withoutWasm=process.argv.includes('--without-wasm')
const optimizationArgument=process.argv.slice(2).find(x=>x.startsWith('--opt='))
const optimization=optimizationArgument?.slice(6)??'Oz'
if(!['O1','O2','O3','Oz'].includes(optimization))throw new Error('Expected --opt=O1, O2, O3, or Oz')
const startedAt=new Date().toISOString()
const diagnosticFields=['phase','comparatorEntries','sortCalls','elementCount','aValid','bValid','opaqueMatches','ctxMatches','aIndex','bIndex','hasMethod','exception','aTag','bTag','rqEntries','rqCount','rqElementSize','rqBaseMatches','rqComparatorMatches','rqOpaqueMatches','rqPhase','rqInsertionIterations','rqComparisonAttempts','rqCountMatches','rqElementSizeMatches','rqPiValid','rqPjValid','rqPiIndex','rqPjIndex']
for (const boundary of ['AfterSwap','AfterBlockSwap','EarlyReturn','InitialPush','Pop','BeforeInsertion','Exit']) {
  for (const fact of ['Visits','Count','Size','CountMatches','SizeMatches','BaseMatches','StackActive']) {
    diagnosticFields.push(`rq${boundary}${fact}`)
  }
}
for (const site of ['AfterWrites','AfterPushObserver','BeforeLoads','AfterLoads']) {
  for (const fact of ['Visits','Count','CountMatches','BaseMatches','SlotIsFirst','DepthIsZero']) {
    diagnosticFields.push(`rqSlot${site}${fact}`)
  }
}
const builds={}
for (const site of ['BeforeDecrement','AfterDecrement']) {
  for (const fact of ['Visits','IsFirst','IsSecond','InRange','Aligned','OriginalCount','OriginalCountMatches','OriginalBaseMatches','OriginalDepthZero']) {
    diagnosticFields.push(`rqPosition${site}${fact}`)
  }
}
const report=(finishedAt=null)=>({startedAt,finishedAt,node:process.version,withoutWasm,builds,diagnosticFields,results})
const cases=[
  {name:'plain-sort',source:`JSON.stringify(['answer','add'].sort())`},
  {name:'host-compiled-function',source:`compile()()`},
  {name:'host-compiled-function-through-module',source:`import {run} from 'entry';globalThis.answer=run();`,module:true},
  {name:'namespace-sort-after-host-compile',source:`import * as ns from 'values';globalThis.answer=compile()(Object.keys(ns));`,module:true},
  {name:'eval-result-object',source:`compile()()`,resultObject:true},
  {name:'nested-loader-wrapper-call',source:`load('entry')`,nested:true},
  {name:'nested-loader-numeric-sort',source:`load('entry')`,nested:true,numeric:true,expected:'[1,2,3]'},
  ...['resolve','source','both'].map(simple=>({name:'nested-loader-simple-'+simple,source:`load('entry')`,nested:true,simple})),
  {name:'nested-loader-direct-invocation',source:`load('entry')`,nested:true,direct:true},
  {name:'nested-loader-precompiled',source:`load('entry')`,nested:true,precompiled:true},
]
const results=[]
for(const combined of withoutWasm?[false]:[false,true])for(const withBootstrap of combined?[false,true]:[false])for(const fixture of cases){
  const root=resolve(`public/quickjs-als-asyncify${combined?'-wasm':''}${optimizationArgument?'-'+optimization.toLowerCase():''}-atomics-fibers-shared-storage${sortDiagnostics?'-sort-diagnostics':''}`)
  const core=await import(pathToFileURL(join(root,'core.mjs')).href)
  const {default:factory}=await import(pathToFileURL(join(root,'engine.mjs')).href)
  const {QuickJSAsyncFFI}=await import(pathToFileURL(join(root,'ffi.mjs')).href)
  if(sortDiagnostics&&!builds[root]){
    const buildBytes=readFileSync(join(root,'build.json'))
    const hashes=Object.fromEntries(['engine.wasm','engine.mjs','core.mjs','ffi.mjs'].map(name=>[name,createHash('sha256').update(readFileSync(join(root,name))).digest('hex')]))
    builds[root]={metadata:JSON.parse(buildBytes),buildJSONSHA256:createHash('sha256').update(buildBytes).digest('hex'),hashes}
  }
  let nativeModule
  const engine=await core.newQuickJSAsyncWASMModuleFromVariant({type:'async',importFFI:async()=>QuickJSAsyncFFI,importModuleLoader:async()=>async()=>{
    nativeModule=await factory({wasmBinary:readFileSync(join(root,'engine.wasm'))})
    return nativeModule
  }})
  const runtime=engine.newRuntime(),context=runtime.newContext(),handles=[],cleanup=[]
  runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(256*1024)
  let task,answer,error,diagnostics,diagnosticsError,calls=0,taken=false
  const evaluate=(source,name='setup.js')=>context.unwrapResult(context.evalCode(source,name))
  const wrapper=`(function(exports,require,module,__filename,__dirname){module.exports=${fixture.numeric?'JSON.stringify([3,1,2].sort((a,b)=>a-b))':"JSON.stringify(['answer','add'].sort())"}})`
  try{
    if(withBootstrap)evaluate(bootstrap,'wasm-bootstrap.js').dispose()
    const precompiled=fixture.precompiled?evaluate(wrapper,'precompiled.js'):undefined
    if(precompiled)handles.push(precompiled)
    const compile=context.newFunction('compile',(...args)=>{
      calls++
      const body=fixture.nested?context.getString(args[0]):`(function(values){return JSON.stringify((values||['answer','add']).sort())})`
      const result=precompiled?{value:precompiled.dup()}:context.evalCode(body,'host-compiled.js')
      if(result.error)return {error:result.error}
      handles.push(result.value)
      return fixture.resultObject||fixture.nested?result:result.value
    })
    context.setProp(context.global,'compile',compile);compile.dispose()
    if(fixture.nested){
      for(const [name,callback] of Object.entries({
        resolve:id=>fixture.simple==='resolve'||fixture.simple==='both'?{value:context.newString('resolved:'+context.getString(id))}:context.evalCode(`'resolved:'+${JSON.stringify(context.getString(id))}`,'resolve.js'),
        source:id=>fixture.simple==='source'||fixture.simple==='both'?{value:context.newString(wrapper)}:context.evalCode(JSON.stringify(wrapper),'source.js'),
      })){
        const fn=context.newFunction(name,(...args)=>{const result=callback(...args);if(result.value)handles.push(result.value);return result})
        context.setProp(context.global,name,fn);fn.dispose()
      }
      evaluate(`globalThis.load=function(id){const name=resolve(id),text=source(name),fn=compile(text),module={exports:{}};${fixture.direct?"fn(module.exports,load,module,name,'/')":"fn.call(module.exports,module.exports,load,module,name,'/')"};return module.exports}`).dispose()
    }
    runtime.setModuleLoader(name=>name==='entry'?`export function run(){return compile()()}`:`export const answer=42;export function add(a,b){return a+b}`,(_base,name)=>name)
    task=context.startFiberEval(fixture.source,'reentrant-sort.mjs',fixture.module?1:0)
    const status=task.step()
    if(status!==2)throw Error('Unexpected suspended status '+status)
    const result=task.takeResult();taken=true
    try{
      if(result.error)throw Error(JSON.stringify(context.dump(result.error)))
      if(fixture.module){const value=context.getProp(context.global,'answer');try{answer=context.getString(value)}finally{value.dispose()}}
      else answer=context.getString(result.value)
    }finally{result.dispose()}
    if(!sortDiagnostics){task.dispose();task=undefined}
    if(answer!==(fixture.expected??'["add","answer"]'))throw Error('Wrong sorted output: '+answer)
  }catch(cause){error=cause.stack??String(cause)}
  finally{
    if(sortDiagnostics){
      try{
        if(typeof nativeModule?._QJS_SortDiagnosticGet!=='function')throw Error('Missing QJS_SortDiagnosticGet export')
        diagnostics=Object.fromEntries(diagnosticFields.map((name,index)=>[name,nativeModule._QJS_SortDiagnosticGet(index)>>>0]))
      }catch(cause){diagnosticsError=cause.stack??String(cause)}
    }
    const attempt=fn=>{try{fn()}catch(cause){cleanup.push(cause.stack??String(cause))}}
    if(task){if(!taken){attempt(()=>task.cancel());attempt(()=>task.step());attempt(()=>{if(task.status()===2)task.takeResult().dispose()})}attempt(()=>task.dispose())}
    for(const handle of handles)attempt(()=>{if(handle.alive)handle.dispose()})
    attempt(()=>context.dispose());attempt(()=>runtime.dispose())
  }
  const record={combined,withBootstrap,case:fixture.name,calls,answer,error,cleanup,...(sortDiagnostics?{root,diagnostics,diagnosticsError}:{})}
  results.push(record);console.log(JSON.stringify(record))
  if(sortDiagnostics){
    mkdirSync('reports',{recursive:true})
    writeFileSync('reports/fiber-reentrant-sort-diagnostics.json',JSON.stringify(report(),null,2)+'\n')
  }
}
if(sortDiagnostics){
  const finishedAt=new Date().toISOString()
  // Hash the sorted engine set because a single attempt can compare two engines.
  const engineSetSHA256=createHash('sha256').update(JSON.stringify(Object.entries(builds).map(([root,build])=>[root,build.hashes['engine.wasm']]).sort(([a],[b])=>a.localeCompare(b)))).digest('hex')
  const finalReport=JSON.stringify({...report(finishedAt),engineSetSHA256},null,2)+'\n'
  const directory='reports/fiber-reentrant-sort-runs'
  mkdirSync(directory,{recursive:true})
  const stem=`${startedAt.replaceAll(':','-')}-${engineSetSHA256}`
  // Exclusive creation preserves earlier evidence even if timestamps collide.
  let suffix=0
  for(;;){
    try{writeFileSync(join(directory,`${stem}${suffix?`-${suffix}`:''}.json`),finalReport,{flag:'wx'});break}
    catch(error){if(error.code!=='EEXIST')throw error;suffix++}
  }
  writeFileSync('reports/fiber-reentrant-sort-diagnostics.json',finalReport)
}
console.log(JSON.stringify({passed:results.filter(result=>!result.error&&!result.cleanup.length&&!result.diagnosticsError).length,total:results.length}))
if(results.some(result=>result.error||result.cleanup.length||result.diagnosticsError))process.exitCode=1
