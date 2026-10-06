import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import ts from 'typescript'
import {buildNativeSDKEntry,assertNativeSDKModuleGraph} from '../scripts/build-native-sdk-entry.mjs'
import {buildSDKTypes} from '../scripts/build-sdk-types.mjs'
import {buildSDKAPIContract} from '../scripts/sdk-api-contract.mjs'
import {verifyNativeBrowserEntry} from '../scripts/verify-sdk.mjs'
import {assertNativeSDKRuntimePaths} from '../scripts/native-sdk-boundary.mjs'

test('native boundary rejects legacy imports even when not used in output',()=>{
  for(const path of ['src/sdk/index.ts','src/sdk/agent-session.ts','src/sdk/worker-kernel.ts',
    'src/sandbox/kernel.ts','src/sandbox/kernel.worker.ts?worker','src/sandbox/compile.ts',
    'src/compiler/builtins.ts','node_modules/quickjs-emscripten-core/dist/index.mjs',
    'node_modules/@jitl/quickjs-wasmfile-release-sync/index.js',
    'node_modules/.pnpm/quickjs-emscripten-core@0.31.0/node_modules/quickjs-emscripten-core/dist/index.js']){
    assert.throws(()=>assertNativeSDKModuleGraph([resolve(path)]),/imports legacy runtime/)
  }
  assert.deepEqual(assertNativeSDKModuleGraph([resolve('src/sdk/agent-session-core.ts'),resolve('src/native/dev-server.ts')]),
    ['src/native/dev-server.ts','src/sdk/agent-session-core.ts'])
})

test('native browser bundle has no QuickJS runtime and operates without a default worker',async()=>{
  const root=mkdtempSync(join(tmpdir(),'native-sdk-entry-test-'))
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}))
  const evidence=await buildNativeSDKEntry(root)
  const seen=new Set(['native.js','native-entry-graph.json'])
  verifyNativeBrowserEntry(root,evidence,seen)
  assert.throws(()=>verifyNativeBrowserEntry(root,undefined,seen),/requires module graph evidence/)
  const poisoned={...evidence,modules:[...evidence.modules,'src/sandbox/kernel.ts'].sort()}
  writeFileSync(join(root,'native-entry-graph.json'),JSON.stringify(poisoned))
  assert.throws(()=>verifyNativeBrowserEntry(root,poisoned,seen),/imports legacy runtime/)
  writeFileSync(join(root,'native-entry-graph.json'),JSON.stringify(evidence))
  assert.throws(()=>verifyNativeBrowserEntry(root,{...evidence,entryBytes:0},seen),/differs from manifest/)
  assert.ok(evidence.modules.includes('src/sdk/agent-session-core.ts'))
  assert.ok(evidence.modules.includes('src/native/agent-backend.ts'))
  assert.equal(evidence.runtimeAssetsIncluded,false)
  const sdk=await import(pathToFileURL(join(root,'native.js')).href)
  for(const name of ['AgentSession','NativeAgentBackend','NativeOwnerClient','NativeDevServer','URLPreview'])assert.equal(typeof sdk[name],'function')
  for(const name of ['WorkerKernel','HostedKernel','runMvdanShell','runShell','resolveSDKRuntimeProfile'])assert.equal(name in sdk,false)
  assert.throws(()=>new sdk.AgentSession(),/backend is required/)
  assert.throws(()=>new sdk.AgentSession({}, {maxOutputBytes:0}),/maxOutputBytes/)
  const files=new Map([['/app/value.txt',new TextEncoder().encode('before')]])
  let closed=false,disposed=0,index=0
  const backend={workspaceRoot:'/app',
    readFile:async path=>files.get(path),writeFile:async(path,bytes)=>{files.set(path,bytes)},
    snapshot:async()=>({version:5,files:Object.fromEntries(files),directories:['/','/app'],symlinks:{},fileModes:{},directoryModes:{}}),
    restore:async snapshot=>{files.clear();for(const [path,bytes] of Object.entries(snapshot.files))files.set(path,bytes)},
    spawn:async()=>({next:async()=>index++?{type:'exit',code:0,signal:null}:{type:'stdout',bytes:new TextEncoder().encode('native')},
      wait:async()=>({exitCode:0,signal:null}),kill:async()=>true,dispose:async()=>{disposed++}}),
    close(){closed=true},shutdown:Promise.resolve(),
  }
  const session=new sdk.AgentSession(backend,{telemetry:{capacity:8}})
  const snapshot=await session.snapshot({encoding:'binary'})
  await session.write({path:'/app/value.txt',text:'after'})
  assert.deepEqual(await session.read({path:'/app/value.txt'}),{text:'after'})
  await session.restore({snapshot})
  assert.deepEqual(await session.read({path:'/app/value.txt'}),{text:'before'})
  assert.deepEqual(await session.run({command:'node'}),{stdout:'native',stderr:'',status:0,signal:null,truncated:false})
  assert.equal(disposed,1)
  await session.close();assert.equal(closed,true)
  assert.equal(session.telemetry.events().at(-1).type,'session.close')
})

test('native API declarations work outside the source tree without ambient types',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-sdk-types-test-'))
  const declarations=buildSDKTypes(root,{entry:'src/sdk/native.ts'})
  assert.equal(declarations.entry,'./types/sdk/native.d.ts')
  assert.equal(declarations.files.includes('types/sdk/index.d.ts'),false)
  assert.equal(declarations.files.includes('types/sdk/agent-session.d.ts'),false)
  const contract=buildSDKAPIContract(root,declarations,{requireCompatibility:true,internalStaging:true})
  assert.ok(contract.exports['.'].includes('AgentSession'))
  assert.equal(contract.exports['.'].includes('WorkerKernel'),false)
  const consumer=join(root,'consumer.ts')
  writeFileSync(consumer,`import {AgentSession,NativeAgentBackend,NativeOwnerClient,installNativeOwnerHost,PackageDownloadPolicy,SDK_COMPATIBILITY} from './types/sdk/native.js';
declare const owner: NativeOwnerClient;
const policy: PackageDownloadPolicy = {additionalOrigins: ['https://packages.example'] as const};
installNativeOwnerHost({allowedParentOrigin: 'https://app.example', workerURL: '/runtime/native/engine.js', packageDownloadPolicy: policy});
// @ts-expect-error Projects cannot change the owner host's download policy.
owner.start({}, {packageDownloadPolicy: policy});
const agent = new AgentSession(new NativeAgentBackend(owner), {maxOutputBytes: 1024});
agent.read({path: '/app/package.json'});
agent.snapshot({encoding: 'binary'});
const version: 8 = SDK_COMPATIBILITY.apiVersion;
// @ts-expect-error Native sessions require an explicitly owned backend.
new AgentSession();
// @ts-expect-error Kernel configuration is not an agent tool option.
new AgentSession(new NativeAgentBackend(owner), {cooperative: true});
`)
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}))
  for(const [module,moduleResolution] of [[ts.ModuleKind.ESNext,ts.ModuleResolutionKind.Bundler],[ts.ModuleKind.NodeNext,ts.ModuleResolutionKind.NodeNext]]){
    const program=ts.createProgram([consumer],{target:ts.ScriptTarget.ES2022,module,moduleResolution,
      strict:true,noEmit:true,skipLibCheck:false,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts']})
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n')),[])
    assert.equal(program.getSourceFiles().some(file=>file.fileName.startsWith(resolve('src')+'/')),false)
  }
  assert.equal(readFileSync(join(root,declarations.entry),'utf8').includes('WorkerKernel'),false)
})

test('native package root carries the same verified entry boundary',async()=>{
  const root=mkdtempSync(join(tmpdir(),'native-sdk-root-test-'))
  const evidence=await buildNativeSDKEntry(root,{filename:'index.js'})
  assert.equal(evidence.entry,'index.js')
  verifyNativeBrowserEntry(root,evidence,new Set(['index.js','native-entry-graph.json']))
  await assert.rejects(buildNativeSDKEntry(root,{filename:'legacy.js'}),/Unknown native SDK entry/)
})

test('native runtime inventory accepts only native catalog and shell paths',()=>{
  assert.doesNotThrow(()=>assertNativeSDKRuntimePaths(['index.js','runtime/native/vite-8.3.1-rolldown-1.2.11/engine.js',
    'runtime/mvdan-shell/shell.wasm','runtime/workers/mvdan-shell.js','runtime/workers/runtime-assets-abc_123.js']))
  for(const path of ['kernel-host.js','runtime/workers/kernel.js','runtime/workers/compiler.js',
    'runtime/engines/quickjs.wasm','runtime/vm-web-apis/engine.js','runtime/http2-runtime/engine.js',
    'runtime/native/../engines/quickjs.wasm','runtime/native//engine.js'])
    assert.throws(()=>assertNativeSDKRuntimePaths([path]),/legacy kernel host|unsupported runtime asset|Invalid native runtime/)
})
