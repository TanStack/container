import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {coordinateViteModuleEvaluationClient,coordinateViteModuleEvaluationCompiler} from '../scripts/vite-module-evaluation.mjs'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),{parseSync}=require('@babel/core'),{Buffer:BrowserBuffer}=require('buffer/')
const roots=['node_modules/vite8-browser','tests/fixtures/native-runtime-832/node_modules/vite']
const tick=()=>new Promise(resolve=>setImmediate(resolve)),update=(path,timestamp=10,acceptedPath=path)=>({type:'js-update',path,acceptedPath,timestamp})
const packet=url=>JSON.parse(Buffer.from(url.slice('/observer/'.length),'base64url').toString('utf8'))
function setup(root){
  const source=coordinateViteModuleEvaluationClient(readFileSync(root+'/dist/client/client.mjs','utf8')),start=source.indexOf('//#region src/shared/hmr.ts'),end=source.indexOf('//#endregion',start)
  const {HMRClient,HMRContext}=new Function('_defineProperty',source.slice(start,end)+';return {HMRClient,HMRContext};')((object,key,value)=>{object[key]=value})
  const imports=[],errors=[],diagnostics=[],client=new HMRClient({debug(){},error:error=>errors.push(error)},{send:async()=>{}},async payload=>{imports.push(payload);return {value:payload.timestamp}})
  const context=path=>new HMRContext(client,path);context('/diagnostics').on('vite:module-evaluation-observer-error',value=>diagnostics.push(value));return {client,context,imports,errors,diagnostics}
}
for(const root of roots){
  const version=JSON.parse(readFileSync(root+'/package.json')).version
  test(version+': registration of a hundred modules does not load helpers or mark them pending',async()=>{
    const s=setup(root),loads=[]
    for(let i=0;i<100;i++)s.client.observeEvaluation('/'+i,'https://example.test/'+i+'.js','/observer/',url=>{loads.push(url);return Promise.resolve({default:{}})})
    await tick();assert.deepEqual(loads,[]);assert.equal(s.client.pendingImports.size,0);assert.equal(s.client.evaluationObserverTokens.size,0);assert.equal(s.client.evaluationObservers.size,100);s.client.clear();await tick();assert.equal(s.client.evaluationObservers.size,0)
  })
  test(version+': a real update starts observation and waits for actual native settlement',async()=>{
    const s=setup(root),loads=[],calls=[];let finish
    const completion=s.client.observeEvaluation('/lazy','https://example.test/lazy.js','/observer/',url=>{loads.push(url);s.client.markEvaluationObserverStarted(packet(url)[1]);return new Promise(resolve=>finish=resolve)})
    s.context('/lazy').accept(module=>calls.push(module.value));await tick();assert.deepEqual(loads,[])
    await s.client.queueUpdate(update('/lazy'));await tick();assert.equal(loads.length,1);assert.deepEqual(calls,[]);assert.equal(s.client.pendingImports.has('/lazy'),true)
    finish({default:{}});await completion;await tick();assert.deepEqual(calls,[10]);assert.equal(s.client.pendingImports.size,0);assert.equal(s.client.evaluationObservers.size,0)
  })
  test(version+': registration after a deferred early update starts observation before replay',async()=>{
    const s=setup(root),calls=[];let finish
    await s.client.queueUpdate(update('/lazy'));await tick();assert.equal(s.client.deferredUpdates.size,1)
    const completion=s.client.observeEvaluation('/lazy','https://example.test/lazy.js','/observer/',url=>{s.client.markEvaluationObserverStarted(packet(url)[1]);return new Promise(resolve=>finish=resolve)})
    s.context('/lazy').accept(module=>calls.push(module.value));await tick();assert.deepEqual(calls,[])
    finish({default:{}});await completion;await tick();assert.deepEqual(calls,[10]);assert.equal(s.client.pendingImports.size,0)
  })
  test(version+': dependency updates wait for both the owner and accepted identity',async()=>{
    const s=setup(root),finish={},calls=[]
    for(const path of ['/parent','/child'])s.client.observeEvaluation(path,'https://example.test'+path+'.js','/observer/',url=>{s.client.markEvaluationObserverStarted(packet(url)[1]);return new Promise(resolve=>finish[path]=resolve)})
    s.context('/parent').accept('/child',module=>calls.push(module.value));await s.client.queueUpdate(update('/parent',10,'/child'));await tick();assert.equal(s.client.pendingImports.size,2)
    finish['/parent']({default:{}});await tick();assert.deepEqual(calls,[]);finish['/child']({default:{}});await tick();assert.deepEqual(calls,[10]);assert.equal(s.client.pendingImports.size,0)
  })
  test(version+': observer failure retries twice then pauses until a new real edit',async()=>{
    const s=setup(root),loads=[],calls=[];let available=false,finish
    const completion=s.client.observeEvaluation('/lazy','https://example.test/lazy.js','/observer/',url=>{loads.push(url);if(!available)return Promise.reject(Error('unavailable'));s.client.markEvaluationObserverStarted(packet(url)[1]);return new Promise(resolve=>finish=resolve)})
    s.context('/lazy').accept(module=>calls.push(module.value));await s.client.queueUpdate(update('/lazy'));await tick();assert.equal(loads.length,2);assert.equal(s.diagnostics.length,1);assert.deepEqual(calls,[]);assert.equal(s.client.failedImports.has('/lazy'),false)
    await tick();assert.equal(loads.length,2);available=true;await s.client.queueUpdate(update('/lazy',20));await tick();assert.equal(loads.length,3)
    finish({default:{}});await completion;await tick();assert.deepEqual(calls,[20]);assert.equal(s.client.pendingImports.size,0)
  })
  test(version+': original rejection surfaces once and allows repair without hot registration',async()=>{
    const s=setup(root),error=Error('original evaluation error');let fail
    const completion=s.client.observeEvaluation('/lazy','https://example.test/lazy.js','/observer/',url=>{s.client.markEvaluationObserverStarted(packet(url)[1]);return new Promise((resolve,reject)=>fail=reject)})
    await s.client.queueUpdate(update('/lazy'));await tick();fail(error);await assert.rejects(completion,value=>value===error);await tick();assert.equal(s.imports.length,1);assert.equal(s.diagnostics.length,0);assert.equal(s.client.pendingImports.size,0)
  })
  test(version+': clear cancels idle and active lifetimes and ignores old marker completion',async()=>{
    const s=setup(root);let finish,token
    const idle=s.client.observeEvaluation('/idle','https://example.test/idle.js','/observer/',()=>{throw Error('idle must not load')})
    const active=s.client.observeEvaluation('/active','https://example.test/active.js','/observer/',url=>{token=packet(url)[1];return new Promise(resolve=>finish=resolve)})
    await s.client.queueUpdate(update('/active'));await tick();s.client.clear();assert.equal(await idle,null);assert.equal(await active,null);s.client.markEvaluationObserverStarted(token);finish({default:{}});await tick()
    assert.equal(s.client.pendingImports.size,0);assert.equal(s.client.evaluationObservers.size,0);assert.equal(s.client.evaluationObserverTokens.size,0);assert.equal(s.imports.length,0)
  })
  test(version+': prune removes only the affected idle record',async()=>{
    const s=setup(root),a=s.client.observeEvaluation('/a','https://example.test/a.js','/observer/',()=>{throw Error('no request')}),b=s.client.observeEvaluation('/b','https://example.test/b.js','/observer/',()=>{throw Error('no request')})
    await s.client.prunePaths(['/a']);assert.equal(await a,null);assert.equal(s.client.evaluationObservers.has('/a'),false);assert.equal(s.client.evaluationObservers.has('/b'),true);assert.equal(s.client.pendingImports.size,0);s.client.clear();assert.equal(await b,null)
  })
  test(version+': pinned transforms parse and reject missing, changed and duplicate anchors',()=>{
    const rawClient=readFileSync(root+'/dist/client/client.mjs','utf8'),rawCompiler=readFileSync(root+'/dist/node/chunks/node.js','utf8')
    const client=coordinateViteModuleEvaluationClient(rawClient),compiler=coordinateViteModuleEvaluationCompiler(rawCompiler)
    parseSync(client,{configFile:false,babelrc:false,sourceType:'module'});parseSync(compiler,{configFile:false,babelrc:false,sourceType:'module'})
    assert.throws(()=>coordinateViteModuleEvaluationClient(client),/already installed/)
    assert.throws(()=>coordinateViteModuleEvaluationCompiler(compiler),/already installed/)
    assert.throws(()=>coordinateViteModuleEvaluationClient('export const value=1'),/anchor changed/)
    assert.throws(()=>coordinateViteModuleEvaluationCompiler('export const value=1'),/anchor changed/)
    assert.throws(()=>coordinateViteModuleEvaluationClient(rawClient.replace('if (!mod) return;','if (!mod) throw Error();')),/anchor changed/)
  })
  test(version+': the observer plugin uses the actual browser Buffer and preserves base paths',()=>{
    const compiler=coordinateViteModuleEvaluationCompiler(readFileSync(root+'/dist/node/chunks/node.js','utf8'))
    const start=compiler.indexOf("{\n      name: 'vite:module-evaluation-observer'"),end=compiler.indexOf('} : null,',start)
    assert.ok(start>0&&end>start)
    const plugin=new Function('config','CLIENT_PUBLIC_PATH','joinUrlSegments','Buffer','return ('+compiler.slice(start,end+1)+')')(
      {base:'/sandbox/'},'/@vite/client',(base,url)=>base.replace(/\/$/,'')+'/'+url.replace(/^\//,''),BrowserBuffer)
    const target='https://example.test/src/%E2%98%83.js?t=123&feature=component',token=7
    const encode=(phase,url=target,id=token)=>'\0tanstack-module-evaluation:'+Buffer.from(JSON.stringify([url,id,phase])).toString('base64url')
    const code=plugin.load(encode('observe'));parseSync(code,{configFile:false,babelrc:false,sourceType:'module'})
    assert.ok(code.includes(';import * as namespace from '+JSON.stringify(target)+';export default namespace;'))
    assert.ok(code.startsWith('import "\\u0000tanstack-module-evaluation:'))
    const marker=JSON.parse(code.slice('import '.length,code.indexOf(';')))
    assert.equal(marker,encode('start'))
    assert.equal(plugin.load(marker),'import {markModuleEvaluationObserverStarted} from "/sandbox/@vite/client";markModuleEvaluationObserverStarted(7);')
    assert.equal(plugin.resolveId(marker),marker);assert.equal(plugin.load('/ordinary.js'),undefined)
    assert.equal(plugin.applyToEnvironment({config:{consumer:'client',isBundled:false}}),true)
    assert.equal(plugin.applyToEnvironment({config:{consumer:'server',isBundled:false}}),false)
    assert.equal(plugin.applyToEnvironment({config:{consumer:'client',isBundled:true}}),false)
    assert.throws(()=>plugin.load(encode('unknown')),/Invalid evaluation observer phase/)
    assert.throws(()=>plugin.load(encode('observe','file:///x')),/Invalid evaluation observer module/)
    assert.throws(()=>plugin.load(encode('observe',target,0)),/Invalid evaluation observer module/)
  })
}

test('native build applies the matched client and compiler corrections before AST rewriting',()=>{
  const build=readFileSync('scripts/build-browser-vite.mjs','utf8')
  assert.ok(build.includes('coordinateViteModuleEvaluationClient(viteClientEntry)'))
  assert.ok(build.includes('__VITE_CLIENT_ENTRY__: JSON.stringify(browserViteClientEntry)'))
  assert.ok(build.indexOf('source=coordinateViteModuleEvaluationCompiler(source)')<build.indexOf('source=retryInvalidatedViteClientTransform(source)'))
  assert.ok(build.includes('moduleEvaluationCompilerApplied!==1'))
  assert.ok(build.includes("bundledInputs.add(path.join(projectRoot,'scripts/vite-module-evaluation.mjs'))"))
  assert.ok(build.includes('nativeModuleEvaluationOwnership:true,demandDrivenModuleObservation:true'))
})
