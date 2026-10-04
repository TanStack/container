import {chromium,firefox,webkit} from 'playwright'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {transform} from 'esbuild'

const compilerSource=(await transform(readFileSync(new URL('../src/native/browser-module-function.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'})).code+'\n'+(await transform(readFileSync(new URL('../src/native/browser-source-locations.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'})).code
const errorSource=(await transform(readFileSync(new URL('../src/native/browser-error-constructor.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'})).code

// Keep browser compilation behavior separate from container stack handling.
for(const engine of [chromium,firefox,webkit]){
  const browser=await engine.launch({headless:true})
  try{
    const page=await browser.newPage()
    const results=await page.evaluate(async compilerSource=>{
      const compilerURL=URL.createObjectURL(new Blob([compilerSource],{type:'text/javascript'}))
      const {createBrowserModuleFunction,BrowserSourceLocations,createBrowserErrorConstructor}=await import(compilerURL)
      URL.revokeObjectURL(compilerURL)
      const compiled=[]
      for(const declaration of ['', 'const Function=()=>42;', 'class Function {static answer=42};', 'function Function(){return 42};']){
        const exports={}
        const module=await createBrowserModuleFunction(['exports'],declaration+'exports.answer=Function.answer??Function();exports.receiver=this;exports.async=await Promise.resolve(5);exports.capture=()=>new Error("compiled").stack',()=>42)
        try{const evaluate=module.evaluate;await evaluate(exports);compiled.push({answer:exports.answer,strict:exports.receiver===undefined,async:exports.async,url:module.url,stack:exports.capture()})}
        finally{module.dispose()}
      }
      const locationModule=await createBrowserModuleFunction(['exports'],'const marker=1;\nexports.capture=function capture(){\n  return new Error("mapped position").stack;\n}',Function)
      let location
      try{
        const exports={},evaluate=locationModule.evaluate
        await evaluate(exports)
        const stack=exports.capture()
        const frame=stack.split('\n').find(line=>line.includes(locationModule.url))
        const match=frame?.match(/:(\d+):(\d+)\)?$/)
        const sources=new BrowserSourceLocations()
        sources.register(locationModule.url,(line,column)=>line>locationModule.startOffset?{file:'/app/position.js',line:line-locationModule.startOffset,column}:null)
        location={url:locationModule.url,stack,mapped:sources.mapStack(stack),generatedLine:Number(match?.[1]),generatedColumn:Number(match?.[2]),evaluatedLine:Number(match?.[1])-locationModule.startOffset}
      }finally{locationModule.dispose()}
      const errors=new BrowserSourceLocations()
      const GuestError=createBrowserErrorConstructor(Error,stack=>errors.mapStack(stack))
      const errorModule=await createBrowserModuleFunction(['exports','Error'],'exports.capture=()=>new Error("guest",{cause:42});',Function)
      const unregister=errors.register(errorModule.url,(line,column)=>line>2?{file:'/app/guest-error.js',line:line-2,column}:null)
      let guestError
      try{
        const exports={},evaluate=errorModule.evaluate
        await evaluate(exports,GuestError)
        const error=exports.capture()
        class OwnedError extends GuestError {}
        guestError={native:error instanceof Error,mapped:error.stack.includes('/app/guest-error.js:1:'),cause:error.cause,subclass:new OwnedError('owned') instanceof OwnedError}
        error.stack='replacement';guestError.replacement=error.stack
      }finally{unregister();errorModule.dispose()}
      async function moduleStack(sourceURL){
        const source='export function capture(){return new Error("module caller").stack}'
          +(sourceURL?'\n//# sourceURL='+sourceURL:'')
        const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
        try{
          const module=await import(url)
          return {url,stack:module.capture()}
        }finally{URL.revokeObjectURL(url)}
      }
      async function injectedModuleFactory(){
        const code='export default function(Function){return async function(__vite_ssr_exports__,__vite_ssr_import__){const dependency=await __vite_ssr_import__("value");__vite_ssr_exports__.answer=dependency.answer;__vite_ssr_exports__.capture=()=>new Error("factory caller").stack}}'
        const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}))
        try{
          const module=await import(url)
          const exports={}
          await module.default(Function)(exports,async id=>{
            if(id!=='value')throw Error('Unexpected dependency')
            return {answer:42}
          })
          return {url,answer:exports.answer,stack:exports.capture()}
        }finally{URL.revokeObjectURL(url)}
      }
      async function matcherStack(kind,nonTail=false){
        const assertion=nonTail?'const stack=__INLINE_SNAPSHOT__();return {stack}.stack':'return __INLINE_SNAPSHOT__()'
        const callerBody=nonTail?'const stack=assertion();return {stack}.stack':'return assertion()'
        const body='function __INLINE_SNAPSHOT__(){return new Error("snapshot").stack};function assertion(){'+assertion+'};function guestCaller(){'+callerBody+'};return guestCaller'
        let caller,url
        if(kind==='function')caller=new Function(body+'\n//# sourceURL=/app/snapshot.js')()
        else{
          url=URL.createObjectURL(new Blob(['export default function(){'+body+'}'],{type:'text/javascript'}))
          caller=(await import(url)).default()
        }
        try{
          function invoke(callback){return callback()}
          return {url,direct:caller(),wrapped:invoke(caller)}
        }finally{if(url)URL.revokeObjectURL(url)}
      }
      return {
        compiled,
        location,
        guestError,
        eval:eval('(()=>new Error().stack)\n//# sourceURL=/app/eval.js')(),
        function:new Function('return new Error().stack\n//# sourceURL=/app/function.js')(),
        module:await moduleStack(),
        namedModule:await moduleStack('/app/named-module.js'),
        factory:await injectedModuleFactory(),
        functionMatcher:await matcherStack('function'),
        moduleMatcher:await matcherStack('module'),
        nonTailModuleMatcher:await matcherStack('module',true),
      }
    },compilerSource+'\n'+errorSource)
    console.log(JSON.stringify({browser:engine.name(),results}))
    assert.deepEqual(results.guestError,{native:true,mapped:true,cause:42,subclass:true,replacement:'replacement'})
    assert.equal(results.location.generatedLine,5)
    assert.equal(results.location.evaluatedLine,3)
    assert.ok(results.location.generatedColumn>0)
    assert.ok(results.location.mapped.includes(`/app/position.js:3:${results.location.generatedColumn}`))
    for(const compiled of results.compiled){
      assert.equal(compiled.answer,42)
      assert.equal(compiled.strict,true)
      assert.equal(compiled.async,5)
      assert.ok(compiled.stack.includes(compiled.url))
    }
    assert.ok(results.module.stack.includes(results.module.url),`${engine.name()} imported module needs its actual source location`)
    assert.equal(results.factory.answer,42)
    assert.ok(results.factory.stack.includes(results.factory.url),`${engine.name()} injected module factory needs its actual source location`)
    for(const mode of ['direct','wrapped']){
      assert.ok(results.nonTailModuleMatcher[mode].includes('__INLINE_SNAPSHOT__'),`${engine.name()} non-tail module matcher frame (${mode})`)
      assert.ok(results.nonTailModuleMatcher[mode].includes('guestCaller'),`${engine.name()} non-tail module caller frame (${mode})`)
    }
    if(engine!==webkit){
      assert.ok(results.eval.includes('/app/eval.js'))
      assert.ok(results.function.includes('/app/function.js'))
    }
  }finally{await browser.close()}
}
