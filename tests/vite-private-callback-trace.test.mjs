import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {build} from 'esbuild'
import {canonicalCompilerPackageRoot,isCompilerPackageImporter} from '../scripts/compiler-package-paths.mjs'
import {browserCompilerWorkerPool} from '../scripts/compiler-worker-pool.mjs'
import {traceVitePrivateCallback} from '../scripts/vite-private-callback-trace.mjs'

const key=Symbol.for('web-container:vite-private-callback')
test('worker-pool control is explicit, bounded and leaves the default unchanged',()=>{
  assert.deepEqual(browserCompilerWorkerPool({}),{size:4,diagnostic:false})
  assert.deepEqual(browserCompilerWorkerPool({BROWSER_ROLLDOWN_WORKER_POOL_CONTROL:'1'}),{size:1,diagnostic:true})
  assert.deepEqual(browserCompilerWorkerPool({BROWSER_ROLLDOWN_WORKER_POOL_CONTROL:'4'}),{size:4,diagnostic:true})
  for(const value of ['0','2','128','',null])
    assert.throws(()=>browserCompilerWorkerPool({BROWSER_ROLLDOWN_WORKER_POOL_CONTROL:value}),/1, 4 or unset/)
})
const source=`const plugin={resolveSubpathImports(id, importer, isRequire) {
  return resolveSubpathImports(id, importer, {...options,isRequire:resolveOptions.isRequire ?? isRequire});
}};`
const compile=()=>new Function('resolveSubpathImports','partialEnv','options','resolveOptions',
  traceVitePrivateCallback(source)+';return plugin;')
const withObserver=(observer,run)=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,key)
  Object.defineProperty(globalThis,key,{value:observer,configurable:true})
  try{return run()}finally{if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
}

test('instrumentation preserves synchronous results, argument choices and callback outcome',()=>{
  const rows=[],result={unchanged:true}
  const plugin=compile()((...args)=>{rows.push(args);return result},{name:'ssr'},{root:'/app'},{isRequire:true})
  withObserver((...args)=>{rows.push(['start',...args]);return outcome=>rows.push(['end',outcome])},()=>{
    assert.equal(plugin.resolveSubpathImports('#value','/app/main.js',false),result)
  })
  assert.deepEqual(rows,[['start','#value','/app/main.js','ssr'],
    ['#value','/app/main.js',{root:'/app',isRequire:true}],['end','returned']])
})

test('original errors survive and observer errors cannot replace results or exceptions',()=>{
  const original=Error('Original')
  const throws=compile()(()=>{throw original},{name:'ssr'},{},{})
  const returns=compile()(()=>42,{name:'ssr'},{},{})
  const rows=[]
  withObserver(()=>outcome=>{rows.push(outcome);throw Error('Observer finish')},()=>{
    assert.equal(returns.resolveSubpathImports('#value','/app/main.js',false),42)
    assert.throws(()=>throws.resolveSubpathImports('#value','/app/main.js',false),error=>error===original)
  })
  assert.deepEqual(rows,['returned','threw'])
  withObserver(()=>{throw Error('Observer start')},()=>{
    assert.equal(returns.resolveSubpathImports('#value','/app/main.js',false),42)
    assert.throws(()=>throws.resolveSubpathImports('#value','/app/main.js',false),error=>error===original)
  })
})

test('an absent observer still returns an original promise unchanged without awaiting it',()=>{
  const result=Promise.resolve(42)
  const plugin=compile()(()=>result,{name:'ssr'},{},{})
  withObserver(undefined,()=>assert.equal(plugin.resolveSubpathImports('#value','/app/main.js',false),result))
})

test('both exact installed Vite sources contain one supported synchronous callback',()=>{
  for(const root of ['node_modules/vite8-browser','tests/fixtures/native-runtime-832/node_modules/vite']){
    const path=root+'/dist/node/chunks/node.js'
    const transformed=traceVitePrivateCallback(readFileSync(path,'utf8'))
    assert.match(transformed,/web-container:vite-private-callback/)
  }
})

test('missing, duplicated or changed callback shapes reject diagnostic builds',()=>{
  assert.throws(()=>traceVitePrivateCallback('export const value = 1'),/exactly one/)
  assert.throws(()=>traceVitePrivateCallback(source+source.replace('plugin=','plugin2=')),/exactly one/)
  assert.throws(()=>traceVitePrivateCallback(source.replace('return resolveSubpathImports','return other')),/target changed/)
})

test('esbuild loads the real package path and applies the callback transform through package aliases',async()=>{
  for(const alias of ['node_modules/vite8-browser','tests/fixtures/native-runtime-832/node_modules/vite']){
    const root=await canonicalCompilerPackageRoot(alias)
    let applied=0
    const result=await build({
      entryPoints:[join(alias,'dist/node/chunks/node.js')],bundle:false,write:false,format:'esm',
      plugins:[{name:'canonical-vite-callback-test',setup(builder){
        builder.onLoad({filter:/\.js$/},args=>{
          assert.equal(isCompilerPackageImporter(root,args.path),true)
          assert.equal(args.path,join(root,'dist/node/chunks/node.js'))
          applied++
          return {contents:traceVitePrivateCallback(readFileSync(args.path,'utf8')),loader:'js'}
        })
      }}],
    })
    assert.equal(applied,1)
    assert.match(result.outputFiles[0].text,/finishPrivateImport/)
    assert.match(result.outputFiles[0].text,/web-container:vite-private-callback/)
  }
})
