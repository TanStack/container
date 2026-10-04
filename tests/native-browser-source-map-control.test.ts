import {expect,test} from 'vitest'
import {build} from 'esbuild'
import {chromium,firefox,webkit} from 'playwright'
import {transformNativeAsyncContext} from '../src/native/async-context-transform'
import {moduleRunnerTransform,version as viteVersion} from 'vite8-browser'
import {createServer} from 'node:http'
import {transformNodeReturns} from '../src/native/node-return-transform'

test('terminal formatting maps actual implicit browser errors without mutating them',async()=>{
  const bundled=await build({stdin:{contents:`export {createBrowserModuleFunction} from './src/native/browser-module-function';export {workerSourceLocations} from './src/native/browser-source-locations';export {formatCommandError} from './src/native/format-command-error';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})
  for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      const result=await page.evaluate(async helper=>{
        const helperURL=URL.createObjectURL(new Blob([helper],{type:'text/javascript'}))
        const tools=await new Function('url','return import(url)')(helperURL)
        URL.revokeObjectURL(helperURL)
        const compiled=await tools.createBrowserModuleFunction(['exports'],'exports.run=function fail(){\nnull.owned;\n};',Function)
        const unregister=tools.workerSourceLocations.register(compiled.url,(line:number,column:number)=>line>compiled.startOffset?{file:'/app/implicit.js',line:line-compiled.startOffset,column}:null)
        try{
          const exports:any={};await compiled.evaluate(exports)
          try{exports.run();throw Error('Expected an implicit error')}
          catch(error){
            const before=(error as Error).stack
            return {name:(error as Error).name,formatted:tools.formatCommandError(error),unchanged:(error as Error).stack===before,raw:before,url:compiled.url}
          }
        }finally{unregister();compiled.dispose()}
      },bundled.outputFiles[0].text)
      expect(result.name,engine.name()).toBe('TypeError')
      expect(result.formatted,engine.name()).toContain('/app/implicit.js:2:')
      expect(result.raw,engine.name()).toContain(result.url+':')
      expect(result.unchanged,engine.name()).toBe(true)
    }finally{await browser.close()}
  }
},30_000)

test('Node return lowering retains actual caller frames on WebKit',async()=>{
  const cases=['middle()','true?middle():null','true&&middle()','(0,middle())','middle?.()','middle`owned`'].map(expression=>{
    const source=`function middle(){const target={};Error.captureStackTrace(target,middle);return target.stack}function origin(){return ${expression}}exports.capture=origin;`
    return {source,lowered:transformNodeReturns(source,'/app/tail-caller.js').code!}
  })
  const bundled=await build({stdin:{contents:`export {createBrowserModuleFunction} from './src/native/browser-module-function';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})
  for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      const result=await page.evaluate(async({helper,cases})=>{
        const helperURL=URL.createObjectURL(new Blob([helper],{type:'text/javascript'}))
        const tools=await new Function('url','return import(url)')(helperURL)
        URL.revokeObjectURL(helperURL)
        const results=[]
        for(const code of cases.flatMap(item=>[item.source,item.lowered])){
          const compiled=await tools.createBrowserModuleFunction(['exports'],code,Function)
          try{
            const exports:any={};const evaluate=compiled.evaluate;await evaluate(exports)
            results.push({stack:exports.capture(),url:compiled.url})
          }finally{compiled.dispose()}
        }
        return results
      },{helper:bundled.outputFiles[0].text,cases})
      for(let index=1;index<result.length;index+=2){
        expect(result[index].stack,`${engine.name()} case ${index>>1}`).toContain('origin')
        expect(result[index].stack,engine.name()).toContain(result[index].url+':')
      }
      if(engine===webkit)expect(result[0].stack).not.toContain('origin')
    }finally{await browser.close()}
  }
},30_000)

test('worker error installation preserves realm identity on every desktop engine',async()=>{
  const bundled=await build({stdin:{contents:`export {installBrowserErrorConstructor} from './src/native/browser-error-constructor';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})
  const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html>')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
  for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`)
      const result=await page.evaluate(async helper=>{
        const host=Error,hostConstructor=Error.prototype.constructor
        const helperURL=URL.createObjectURL(new Blob([helper],{type:'text/javascript'}))
        const source=`import {installBrowserErrorConstructor} from ${JSON.stringify(helperURL)};
          const Guest=installBrowserErrorConstructor(globalThis,stack=>stack+'\\nmapped');
          const error=new Error('owned',{cause:42});
          const captured={};Error.captureStackTrace(captured);
          class Owned extends Error {}
          let implicit;try{null.missing}catch(error){implicit=error}
          postMessage({global:Error===globalThis.Error&&Error===Guest,
            constructor:error.constructor===Error&&Error.prototype.constructor===Error,
            called:Error('called').constructor===Error,subclass:new Owned().constructor===Owned,
            native:implicit instanceof Error,cause:error.cause,mapped:error.stack.endsWith('mapped'),capture:captured.stack.endsWith('mapped')});`
        const workerURL=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
        const worker=new Worker(workerURL,{type:'module'})
        try{
          const owned=await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('Worker identity check timed out')),10000)
            worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)}
            worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message))}
          })
          return {owned,hostUnchanged:Error===host&&Error.prototype.constructor===hostConstructor}
        }finally{worker.terminate();URL.revokeObjectURL(workerURL);URL.revokeObjectURL(helperURL)}
      },bundled.outputFiles[0].text)
      expect(result,engine.name()).toEqual({owned:{global:true,constructor:true,called:true,subclass:true,native:true,cause:42,mapped:true,capture:true},hostUnchanged:true})
    }finally{await browser.close()}
  }
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
},30_000)

test('maps browser errors through async and installed Vite module-runner transforms',async()=>{
  const original='export async function run(){\n  await Promise.resolve();\n  return new Error("original",{cause:42});\n}'
  const sourceFile='/app/space folder/original file.ts'
  const transformed=await transformNativeAsyncContext(original,sourceFile)
  expect(transformed?.map).toBeTruthy()
  const evaluated=await moduleRunnerTransform(transformed!.code,transformed!.map as any,sourceFile,original)
  expect(evaluated.map).toBeTruthy()
  const bundled=await build({stdin:{contents:`export {createBrowserModuleFunction} from './src/native/browser-module-function';export {BrowserSourceLocations} from './src/native/browser-source-locations';export {createBrowserErrorConstructor} from './src/native/browser-error-constructor';export {TraceMap,originalPositionFor} from '@jridgewell/trace-mapping';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})
  const helper=bundled.outputFiles[0].text
  for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      const result=await page.evaluate(async({helper,code,map,sourceFile})=>{
        const helperURL=URL.createObjectURL(new Blob([helper],{type:'text/javascript'}))
        // Keep this browser import outside Vitest's host-side SSR transform.
        const tools=await new Function('url','return import(url)')(helperURL)
        URL.revokeObjectURL(helperURL)
        const registry=new tools.BrowserSourceLocations()
        const GuestError=tools.createBrowserErrorConstructor(Error,(stack:string)=>registry.mapStack(stack))
        const compiled=await tools.createBrowserModuleFunction(['__vite_ssr_exports__','__vite_ssr_exportName__','Error'],code,Function)
        const traced=new tools.TraceMap(map)
        const unregister=registry.register(compiled.url,(line:number,column:number)=>{
          if(line<=compiled.startOffset)return null
          const position=tools.originalPositionFor(traced,{line:line-compiled.startOffset,column:column-1})
          if(position.source===null||position.line===null||position.column===null)return null
          const base=new URL('file:///');base.pathname=sourceFile
          return {file:decodeURIComponent(new URL(position.source,base).pathname),line:position.line,column:position.column+1}
        })
        try{
          const exports:any={},evaluate=compiled.evaluate
          await evaluate(exports,(name:string,get:()=>unknown)=>Object.defineProperty(exports,name,{enumerable:true,get}),GuestError)
          const error=await exports.run()
          class ConvertedError extends Error {
            constructor(){
              super('converted')
              let stack='captured'
              Object.defineProperty(this,'stack',{configurable:true,get(){return stack},set(value){
                if(value==='reject')throw new TypeError('rejected')
                stack=String(value).toUpperCase()
              }})
            }
          }
          const Converted=tools.createBrowserErrorConstructor(ConvertedError,(stack:string)=>'mapped '+stack)
          const converted=new Converted()
          let rejected=false
          try{converted.stack='reject'}catch{rejected=true}
          const afterRejected=converted.stack
          converted.stack='owned'
          return {stack:error.stack,cause:error.cause,native:error instanceof Error,setter:{rejected,afterRejected,afterConverted:converted.stack}}
        }finally{unregister();compiled.dispose()}
      },{helper,code:evaluated.code,map:JSON.parse(JSON.stringify(evaluated.map)),sourceFile})
      expect(result.stack,`${engine.name()}, installed Vite ${viteVersion}`).toContain(sourceFile+':3:')
      expect(result.cause).toBe(42)
      expect(result.native).toBe(true)
      expect(result.setter,engine.name()).toEqual({rejected:true,afterRejected:'mapped captured',afterConverted:'OWNED'})
    }finally{await browser.close()}
  }
},30_000)

test('retained callbacks keep their own source positions after module reload',async()=>{
  const bundled=await build({stdin:{contents:`export {createBrowserModuleFunction} from './src/native/browser-module-function';export {BrowserSourceLocations} from './src/native/browser-source-locations';export {createBrowserErrorConstructor} from './src/native/browser-error-constructor';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})
  for(const engine of [chromium,firefox,webkit]){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      const stacks=await page.evaluate(async helper=>{
        const helperURL=URL.createObjectURL(new Blob([helper],{type:'text/javascript'}))
        const tools=await new Function('url','return import(url)')(helperURL)
        URL.revokeObjectURL(helperURL)
        const registry=new tools.BrowserSourceLocations()
        const GuestError=tools.createBrowserErrorConstructor(Error,(stack:string)=>registry.mapStack(stack))
        const callbacks:Array<()=>Error>=[],unregister:Array<()=>void>=[]
        try{
          for(const padding of ['', '\n']){
            const compiled=await tools.createBrowserModuleFunction(['exports'],'exports.capture=function capture(){\n'+padding+'const error=new Error("retained");\nreturn error;\n}',Function,GuestError)
            compiled.dispose()
            unregister.push(registry.register(compiled.url,(line:number,column:number)=>line>2?{file:'/app/reload.js',line:line-2,column}:null))
            const exports:any={},evaluate=compiled.evaluate
            await evaluate(exports)
            callbacks.push(exports.capture)
          }
          return callbacks.map(callback=>callback().stack)
        }finally{for(const release of unregister)release()}
      },bundled.outputFiles[0].text)
      expect(stacks[0],engine.name()).toContain('/app/reload.js:2:')
      expect(stacks[1],engine.name()).toContain('/app/reload.js:3:')
    }finally{await browser.close()}
  }
},30_000)
