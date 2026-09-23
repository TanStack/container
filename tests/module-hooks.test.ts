import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
const create=new Function(readFileSync('src/sandbox/guest-module-hooks.js','utf8')+';return createModuleHooks')()
it('chains resolve hooks newest first and deregisters without changing base resolution',()=>{
 const hooks=create((specifier:string)=>JSON.stringify({id:specifier,path:specifier,kind:'module'})),calls:string[]=[]
 hooks.registerHooks({resolve:(s:string,c:any,next:any)=>{calls.push('first');return next(s,c)}})
 const second=hooks.registerHooks({resolve:(s:string,c:any,next:any)=>{calls.push('second');return next(s,c)}})
 expect(JSON.parse(hooks.resolve('file:///value.mjs','file:///main.mjs','import')).id).toBe('file:///value.mjs')
 expect(calls).toEqual(['second','first']);second.deregister();calls.length=0
 hooks.resolve('file:///value.mjs','file:///main.mjs','import');expect(calls).toEqual(['first'])
 expect(()=>hooks.registerHooks({initialize:()=>({})})).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
})
it('rejects incomplete and asynchronous chains rather than silently resolving unhooked',()=>{
 const hooks=create((s:string)=>JSON.stringify({id:s,path:s,kind:'module'}))
 const entry=hooks.registerHooks({resolve:()=>({url:'file:///value.mjs'})})
 expect(()=>hooks.resolve('x','file:///main.mjs','import')).toThrow(expect.objectContaining({code:'ERR_LOADER_CHAIN_INCOMPLETE'}));entry.deregister()
 hooks.registerHooks({resolve:async()=>({url:'file:///value.mjs',shortCircuit:true})})
 expect(()=>hooks.resolve('x','file:///main.mjs','import')).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
})
it('native resolve hooks support short circuit and deregistration',()=>{
 const run=spawnSync(process.execPath,['--input-type=module','-e',`import {registerHooks} from 'node:module';const h=registerHooks({resolve(s,c,next){return s==='fixture'?{url:'data:text/javascript,export default 42',shortCircuit:true}:next(s,c)}});console.log((await import('fixture')).default);h.deregister();try{await import('missing-after-deregister')}catch(e){console.log(e.code)}`],{encoding:'utf8',timeout:5000})
 expect(run.status,run.stderr).toBe(0);expect(run.stdout.trim().split('\n')).toEqual(['42','ERR_MODULE_NOT_FOUND'])
})
it('installed Rolldown uses synchronous hooks for fresh graphs and dependency tracking on Node',()=>{
 const run=spawnSync(process.execPath,['--input-type=module','-e',`import {freshImport} from './fixtures/workloads/node_modules/rolldown/dist/shared/dist-DKbukT1H.mjs';const url=new URL('./tests/fixtures/module-hook-entry.mjs',import.meta.url).href;const a=await freshImport(url),b=await freshImport(url);console.log(JSON.stringify({value:a.result.default,fresh:a.result!==b.result,tracked:a.dependencies.some(path=>path.endsWith('/module-hook-dependency.mjs'))}))`],{encoding:'utf8',timeout:5000})
 expect(run.status,run.stderr).toBe(0);expect(JSON.parse(run.stdout)).toEqual({value:42,fresh:true,tracked:true})
})
it('chains synchronous source transforms and rejects asynchronous load hooks',()=>{
 const hooks=create((s:string)=>JSON.stringify({id:s,path:s,kind:'module'}),()=>({format:'module',source:'export default 1'}))
 const handle=hooks.registerHooks({load:(url:string,context:any,next:any)=>({...next(url,context),source:'export default 42'})})
 expect(hooks.load('file:///entry.mjs')).toEqual({format:'module',source:'export default 42'})
 handle.deregister();expect(hooks.load('file:///entry.mjs').source).toBe('export default 1')
 hooks.registerHooks({load:async()=>({format:'module',source:'export default 0',shortCircuit:true})})
 expect(()=>hooks.load('file:///entry.mjs')).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
})
it('native load hooks transform source before evaluation',()=>{
 const run=spawnSync(process.execPath,['--input-type=module','-e',`import {registerHooks} from 'node:module';const handle=registerHooks({load(url,context,next){const result=next(url,context);return url.startsWith('data:')?{...result,source:'export default 42'}:result}});try{console.log((await import('data:text/javascript,export default 1')).default)}finally{handle.deregister()}`],{encoding:'utf8',timeout:5000})
 expect(run.status,run.stderr).toBe(0);expect(run.stdout.trim()).toBe('42')
})
it('executes the installed Vitest in-source transform through the load hook chain',async()=>{
 const path='fixtures/workloads/node_modules/vitest/dist/chunks/native.cLbCmZDO.js',source=readFileSync(path,'utf8')
 const helper=source.slice(source.indexOf('function replaceInSourceMarker'),source.indexOf('\nexport { setupNodeLoaderHooks'))
 const require=createRequire(pathToFileURL(resolve(path)))
 const magicString=require('magic-string'),MagicString=magicString.default??magicString
 const {hoistMocks,initSyntaxLexers}=await import(pathToFileURL(resolve('fixtures/workloads/node_modules/@vitest/mocker/dist/transforms.js')).href)
 const {p:parse}=await import(pathToFileURL(resolve('fixtures/workloads/node_modules/vitest/dist/chunks/acorn.C1kjbUFw.js')).href)
 await initSyntaxLexers()
 const make=new Function('MagicString','hoistMocks','parse','resolve','fileURLToPath','distDir','isBuiltin','cleanUrl','module$1','__vitest_mocker__',helper+';return createLoadHook')(MagicString,hoistMocks,parse,resolve,fileURLToPath,'/vitest-dist/',()=>false,(url:string)=>url,{},undefined)
 const hooks=create(()=>'',()=>({format:'module',source:'if (import.meta.vitest) console.log(42)'}))
 hooks.registerHooks({load:make()})
 const output=hooks.load('file:///fixture.mjs?vitest=1').source
 expect(output).toContain('IMPORT_META_TEST()');expect(output).toContain('sourceMappingURL=data:application/json;base64,')
 expect(output).not.toContain('import.meta.vitest')
})
it('preloads async sources atomically, orders initialization and disposes once',async()=>{
 const hooks=create(()=>'',()=>({format:'module',source:'export default 1'})),order:string[]=[]
 let release!:()=>void
 const pending=hooks.preloadModuleSources(['file:///entry.mjs'],{
  initialize:()=>new Promise<void>(resolve=>{order.push('initialize');release=resolve}),
  load:async()=>{order.push('load');return {format:'module',source:'export default 42'}},
  dispose:async()=>{order.push('dispose')},
 })
 expect(()=>hooks.load('file:///entry.mjs')).toThrow(/still pending/)
 release();const registration=await pending
 expect(order).toEqual(['initialize','load','dispose']);expect(hooks.load('file:///entry.mjs').source).toBe('export default 42')
 registration.deregister();expect(hooks.load('file:///entry.mjs').source).toBe('export default 1')
 let disposals=0
 await expect(hooks.preloadModuleSources(['file:///entry.mjs'],{load:async()=>{throw Error('loader failed')},dispose:()=>{disposals++}})).rejects.toThrow('loader failed')
 expect(disposals).toBe(1);expect(hooks.load('file:///entry.mjs').source).toBe('export default 1')
})
