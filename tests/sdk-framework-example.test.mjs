import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {spawnSync} from 'node:child_process'
import {withExampleTests,readScripts,runProjectScript,writeChangedSource,saveProject} from '../examples/sdk-frameworks/scripts.mjs'
import {watchAppPort} from '../examples/sdk-frameworks/ports.mjs'
import {exampleEnginePolicy} from '../examples/sdk-frameworks/engine-policy.mjs'

const projects=JSON.parse(readFileSync('examples/sdk-frameworks/projects.json','utf8'))
test('strict Start consumer accepts the buffer candidate with unchanged fiber policy',()=>{
  const profile='experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops'
  const manifest={buildProfile:profile,engines:{'quickjs-als-asyncify-atomics-fibers-shared-storage':{},'quickjs-als-asyncify-wasm-atomics-fibers-shared-storage':{}},experimentalRolldownParser:{enabledByDefault:false,directory:'runtime/rolldown-parser',artifact:'runtime/rolldown-parser/artifact.json'}}
  const candidate={...manifest,buildProfile:profile+'-segmented-interpreter-batched-native-utf8-buffer'}
  assert.deepEqual(exampleEnginePolicy(candidate),{...exampleEnginePolicy(manifest),profile:candidate.buildProfile})
  assert.throws(()=>exampleEnginePolicy({...candidate,buildProfile:candidate.buildProfile+'-unknown'}),/Unsupported/)
  assert.throws(()=>exampleEnginePolicy({...candidate,engines:{}}),/missing engine/)
  assert.throws(()=>exampleEnginePolicy({...candidate,experimentalRolldownParser:{...candidate.experimentalRolldownParser,enabledByDefault:true}}),/opt-in native parser/)
})
test('framework example uses the public packaged runtime profile without fallback',()=>{
  const client=readFileSync('examples/sdk-frameworks/client.js','utf8'),server=readFileSync('examples/sdk-frameworks/server.mjs','utf8')
  assert.match(server,/resolveSDKRuntimeProfile\(manifest,'vite'\)/)
  assert.match(server,/resolveSDKRuntimeProfile\(manifest,'tanstack-start'\)/)
  assert.match(client,/\.\.\.runtime.kernelOptions/)
  assert.match(client,/assertSDKRuntimeEnvironment\(runtime\)/)
  assert.match(server,/Object\.entries\(runtimes\.start\.ownerHeaders\)/)
})
test('framework example ships the tested complete manifests and locks',()=>{
  for(const [kind,fixture] of [['vite','install-vitest'],['start','install-start-wasm']]){
    for(const name of ['package.json','package-lock.json'])assert.equal(projects[kind]['/project/'+name],readFileSync('fixtures/'+fixture+'/'+name,'utf8'))
    assert.match(projects[kind]['/project/server.mjs'],/port:8521/)
  }
  for(const name of ['vite.config.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/about.tsx'])assert.equal(projects.start['/project/'+name],readFileSync('fixtures/start-basic/'+name,'utf8'))
})
test('example imports public SDK only and keeps runtime policy explicit',()=>{
  const client=readFileSync('examples/sdk-frameworks/client.js','utf8')
  assert.deepEqual([...client.matchAll(/from '([^']+)'/g)].map(match=>match[1]),['@tanstack/browser-sandbox-experimental','./scripts.mjs','./ports.mjs'])
  assert.doesNotMatch(client,/APP_READY|WorkerHTTP\(session.kernel,8521\)/)
  assert.match(client,/\.\.\.runtime.kernelOptions/)
  assert.match(client,/ignoreScripts:true/)
  assert.match(client,/workerMaxBytes:64\*1024\*1024/)
  assert.match(client,/spawn\('node',\['server.mjs'\],\{cwd:'\/project',guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:128\*1024\*1024,timeoutMs:30000\}\)/)
  assert.match(client,/indexedDB.open/)
  assert.match(client,/session.restore\(\{snapshot:saved\}\)/)
})
test('script runner rereads the manifest and preserves shell output and failure status',async()=>{
  let scripts={test:'node first.mjs',pretest:'do not run',empty:''}
  const session={kernel:{},read:async({path})=>{assert.equal(path,'/project/package.json');return {text:JSON.stringify({scripts})}}}
  assert.deepEqual(await readScripts(session),{test:'node first.mjs',pretest:'do not run'})
  scripts.test='node changed.mjs && printf done'
  const expected={exitCode:1,stdout:new TextEncoder().encode('out'),stderr:new TextEncoder().encode('failure')}
  let calls=0
  assert.equal(await runProjectScript(session,'test',async(kernel,command,options)=>{
    calls++;assert.equal(kernel,session.kernel);assert.equal(command,scripts.test)
    assert.deepEqual(options,{cwd:'/project',writable:true,timeoutMs:30000});return expected
  }),expected)
  assert.equal(calls,1)
  await assert.rejects(runProjectScript(session,'missing',()=>assert.fail('must not run')),/No package script/)
})
test('script execution does not rewrite unchanged source or trigger needless HMR',async()=>{
  const writes=[],session={read:async()=>({text:'same'}),write:async input=>writes.push(input)}
  assert.equal(await writeChangedSource(session,'/project/message.js','same'),false)
  assert.deepEqual(writes,[])
  assert.equal(await writeChangedSource(session,'/project/message.js','changed'),true)
  assert.deepEqual(writes,[{path:'/project/message.js',text:'changed'}])
})
for(const edited of [false,true])test(`Save stops the app before capturing source, edited=${edited}`,async()=>{
  const events=[]
  let current='original'
  const session={
    read:async()=>{events.push('read');return {text:current}},
    write:async({text})=>{events.push('write');current=text},
    snapshot:async options=>{events.push('snapshot '+options.encoding);return {text:current}},
  }
  const result=await saveProject({
    session,path:'/project/source.ts',text:edited?'edited':'original',key:'start',
    stop:async()=>events.push('stop'),
    store:async(key,snapshot)=>{events.push('store');assert.equal(key,'start');assert.equal(snapshot.text,edited?'edited':'original')},
    close:async()=>events.push('close'),
  })
  assert.deepEqual(events,['stop','read',...(edited?['write']:[]),'snapshot binary','store','close'])
  assert.deepEqual(result,{changed:edited})
})
test('framework example persists binary snapshots without changing the Save deadline',()=>{
  const client=readFileSync('examples/sdk-frameworks/client.js','utf8'),spec=readFileSync('tests/sdk/framework-example.spec.mjs','utf8')
  assert.match(readFileSync('examples/sdk-frameworks/scripts.mjs','utf8'),/session\.snapshot\(\{encoding:'binary'\}\)/)
  assert.doesNotMatch(client,/Save timing:/)
  assert.match(spec,/toContainText\('Saved\.'\)/)
  assert.doesNotMatch(spec,/toContainText\('Saved\.'\),\{timeout:/)
})
test('Start test requests the running app and checks its response',()=>{
  const files=withExampleTests(projects.start,'start'),source=files['/project/project.test.mjs']
  assert.match(source,/get\('http:\/\/localhost:8521\/'/)
  assert.match(source,/assert.equal\(response.status,200\)/)
  assert.match(source,/assert.match\(response.body/)
  assert.doesNotMatch(source,/readFileSync/)
  assert.equal(files['/project/package-lock.json'],projects.start['/project/package-lock.json'])
  assert.deepEqual(JSON.parse(files['/project/package.json']).dependencies,JSON.parse(projects.start['/project/package.json']).dependencies)
})
for(const kind of ['vite'])test(kind+' example tests pass, fail on an edit, and recover',()=>{
  const original=JSON.stringify(projects[kind]),files=withExampleTests(projects[kind],kind)
  assert.equal(JSON.stringify(projects[kind]),original)
  assert.equal(files['/project/package-lock.json'],projects[kind]['/project/package-lock.json'])
  const manifest=JSON.parse(files['/project/package.json'])
  assert.equal(manifest.scripts.test,'node project.test.mjs')
  assert.deepEqual(manifest.dependencies,JSON.parse(projects[kind]['/project/package.json']).dependencies)
  const directory=mkdtempSync(join(tmpdir(),'framework-tests-'))
  try{
    for(const [path,text] of Object.entries(files)){
      const target=join(directory,path.slice('/project/'.length));mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text)
    }
    const env={...process.env};delete env.NODE_TEST_CONTEXT
    const run=()=>spawnSync(process.execPath,['--test-reporter=tap','project.test.mjs'],{cwd:directory,env,encoding:'utf8',timeout:10000})
    assert.equal(run().status,0)
    const source=kind==='vite'?'message.js':'src/routes/index.tsx',before=files['/project/'+source]
    writeFileSync(join(directory,source),kind==='vite'?'export const message=""':before.replace('id="start-count"','id="removed"'))
    const failed=run();assert.equal(failed.status,1);assert.match(failed.stdout,/not ok/)
    writeFileSync(join(directory,source),before);assert.equal(run().status,0)
  }finally{rmSync(directory,{recursive:true,force:true})}
})
test('package builder includes the self-contained framework example',()=>{
  const split=readFileSync('scripts/build-sdk-packages.mjs','utf8')
  assert.match(split,/join\(core,'examples',name,file\)/)
  assert.match(split,/frameworks:\['README.md','package.json','index.html','client.js','scripts.mjs','ports.mjs','server.mjs','host.mjs','projects.json'\]/)
  assert.match(split,/basic:\['README.md','package.json','index.html','client.js','server.mjs','host.mjs'\]/)
  assert.doesNotMatch(readFileSync('scripts/build-sdk.mjs','utf8'),/examples\/sdk-|join\(out,'examples'/)
  assert.doesNotMatch(split,/engine-policy/)
  assert.match(readFileSync('examples/sdk-frameworks/server.mjs','utf8'),/path==='\/ports.mjs'/)
  assert.match(readFileSync('scripts/sdk-notices.mjs','utf8'),/'examples\/frameworks\/'/)
  assert.match(readFileSync('src/sdk/README.md','utf8'),/examples\/frameworks\//)
})
test('port watcher uses discovered ports and releases its subscription',async()=>{
  let listener,removed=0
  const watching=watchAppPort({subscribePorts(fn){listener=fn;return ()=>removed++}})
  listener({type:'close',port:1234});listener({type:'open',port:4321})
  assert.equal(await watching.promise,4321)
  watching.cancel();assert.equal(removed,1)
})
test('port watcher handles synchronous replay, cancellation and startup timeout',async()=>{
  let removed=0
  const replay=watchAppPort({subscribePorts(fn){fn({type:'open',port:49152});return ()=>removed++}})
  assert.equal(await replay.promise,49152);assert.equal(removed,1)
  const kernel={subscribePorts(){return ()=>removed++}}
  const cancelled=watchAppPort(kernel);cancelled.cancel()
  await assert.rejects(cancelled.promise,/cancelled/)
  const expired=watchAppPort(kernel,1)
  await assert.rejects(expired.promise,/did not open a port/)
  assert.equal(removed,3)
})
