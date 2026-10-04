import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {Worker} from 'node:worker_threads'
import {Module,createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {fs as constructors} from 'memfs'
import {replaceWasiFsProxy} from '../scripts/wasi-fs-proxy-transport.mjs'
import {createWasiFilesystemClient} from '../src/native/wasi-fs-transport.mjs'
import {createWasiFilesystemEndpoint} from '../src/native/wasi-filesystem-service.mjs'

const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url)
// Compile the real consumers without writing a test build into the source tree.
const built=await build({stdin:{contents:`
  export {nativeFileOperationNames} from './src/native/filesystem-operations';
  export {VolumeFileSystem} from './src/native/volume-file-system';
  export {NativeTerminalFileSession} from './src/native/terminal-file-session';
  export {NativeTerminalProcesses} from './src/native/terminal-processes';
  export {installLiveLockedPackages} from './src/native/live-package-install';
  export {planProjectInstall} from './src/npm/project';
  export {npmProject} from './tests/fixtures/npm-project';
`,resolveDir:root},bundle:true,platform:'node',format:'cjs',packages:'external',write:false})
const compiled=new Module(join(root,'tests/native-filesystem-consumers-control.cjs'))
compiled.filename=compiled.id;compiled.paths=Module._nodeModulePaths(root)
compiled._compile(built.outputFiles[0].text,compiled.filename)
const {nativeFileOperationNames,VolumeFileSystem,NativeTerminalFileSession,NativeTerminalProcesses,
  installLiveLockedPackages,planProjectInstall,npmProject}=compiled.exports

const runtime=dirname(require.resolve('@napi-rs/wasm-runtime'))
assert.equal(JSON.parse(readFileSync(join(runtime,'package.json'))).version,'1.2.4')
const source=replaceWasiFsProxy(readFileSync(join(runtime,'fs-proxy.js'),'utf8'),
  new URL('../src/native/wasi-fs-transport.mjs',import.meta.url).href)+'\nexport {decodeValue};'
const codecURL='data:text/javascript;base64,'+Buffer.from(source).toString('base64'),codec=await import(codecURL)

async function fixture(fn){
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {createNativeFilesystemBackend}=await import(workerData.backendURL),{fs}=createNativeFilesystemBackend();
      const {createWasiFilesystemService}=await import(workerData.serviceURL),codec=await import(workerData.codecURL);
      fs.mkdirSync('/app',{recursive:true});
      const service=createWasiFilesystemService(fs,codec.createOnMessage);
      parentPort.on('message',data=>{
        if(data.type==='inspect')parentPort.postMessage({type:'inspect',...service.inspect(),...service.inspectWatchers()});
        else service.onMessage({data});
      });
      parentPort.postMessage({type:'ready'});
    })().catch(error=>{throw error});
  `,{eval:true,workerData:{codecURL,
    backendURL:new URL('../src/native/filesystem-backend.mjs',import.meta.url).href,
    serviceURL:new URL('../src/native/wasi-filesystem-service.mjs',import.meta.url).href}})
  const endpoints=[]
  try{
    assert.deepEqual((await once(worker,'message',{signal:AbortSignal.timeout(5000)}))[0],{type:'ready'})
    const connect=id=>{
      const endpoint=createWasiFilesystemEndpoint(worker,id);endpoints.push(endpoint)
      const fs=createWasiFilesystemClient(constructors,{decodeValue:codec.decodeValue,timeoutMs:3000,
        send:message=>endpoint.port.postMessage(message)})
      const calls=[]
      // No Volume, toJSON, private core or copied file state exists in this client.
      const operations=Object.fromEntries(nativeFileOperationNames.map(method=>[method,(...args)=>{
        calls.push({method,path:args[0]});return fs[method](...args)
      }]))
      return {operations,calls}
    }
    const inspect=async()=>{
      const reply=once(worker,'message',{signal:AbortSignal.timeout(3000)})
      worker.postMessage({type:'inspect'});return (await reply)[0]
    }
    await fn({connect,inspect})
  }finally{
    for(const endpoint of endpoints)endpoint.dispose()
    await worker.terminate()
  }
}
const settings={timeout:15000}

test('installer view lists remote metadata without copying any file contents',settings,()=>fixture(async({connect})=>{
  const writer=connect('writer'),reader=connect('reader')
  writer.operations.mkdirSync('/app/nested',{recursive:true})
  writer.operations.mkdirSync('/other',{recursive:true})
  writer.operations.writeFileSync('/app/nested/large.bin',new Uint8Array(1024*1024))
  writer.operations.writeFileSync('/other/ignored.txt','unrelated')
  writer.operations.symlinkSync('/app','/app/loop')
  const view=new VolumeFileSystem(reader.operations)
  assert.deepEqual(await view.list('/app'),['/app/nested/large.bin'])
  assert.ok(reader.calls.every(({method,path})=>['lstatSync','readdirSync'].includes(method)&&path.startsWith('/app')))
  assert.deepEqual(await view.list('/app/nested/large.bin'),['/app/nested/large.bin'])
  assert.deepEqual(await view.list('/missing'),[])
}))

test('installer view writes binary files, modes and executable links into the shared authority',settings,()=>fixture(async({connect})=>{
  const writer=connect('writer'),reader=connect('reader'),view=new VolumeFileSystem(writer.operations)
  const bytes=Uint8Array.from({length:200000},(_,index)=>index%251)
  await view.writeFile('/app/pkg/index.bin',bytes,{mode:0o640,followSymlinks:false})
  await view.symlink('/app/pkg/index.bin','/app/node_modules/.bin/pkg')
  assert.deepEqual(Uint8Array.from(reader.operations.readFileSync('/app/pkg/index.bin')),bytes)
  assert.equal(reader.operations.statSync('/app/pkg/index.bin').mode&0o777,0o640)
  assert.equal(String(reader.operations.realpathSync('/app/node_modules/.bin/pkg')),'/app/pkg/index.bin')
  await assert.rejects(view.writeFile('/app/node_modules/.bin/pkg',new Uint8Array([1]),{followSymlinks:false}),/symbolic link/)
}))

test('terminal file sessions use remote descriptors with positioned and implicit byte reads',settings,()=>fixture(async({connect,inspect})=>{
  const first=connect('terminal'),second=connect('reader')
  first.operations.writeFileSync('/app/file.bin',new Uint8Array([0,128,255,4,5]))
  const session=new NativeTerminalFileSession(first.operations)
  try{
    const fd=session.call('open',['/app/file.bin',2,0])
    assert.deepEqual([...session.call('read',[fd,2,2])],[255,4])
    assert.deepEqual([...session.call('read',[fd,2])],[0,128])
    assert.equal(session.call('write',[fd,new Uint8Array([9]),4]),1)
    assert.deepEqual([...session.call('read',[fd,2])],[255,4])
    assert.deepEqual([...second.operations.readFileSync('/app/file.bin')],[0,128,255,4,9])
    session.call('fchmod',[fd,0o600])
    assert.equal(second.operations.statSync('/app/file.bin').mode&0o777,0o600)
    assert.equal((await inspect()).descriptors,1)
  }finally{session.close()}
  assert.equal((await inspect()).descriptors,0)
}))

test('terminal cat streams a large remote file and releases its descriptor',settings,()=>fixture(async({connect,inspect})=>{
  const {operations}=connect('terminal'),bytes=Uint8Array.from({length:1024*1024},(_,index)=>index%251)
  operations.writeFileSync('/app/large.bin',bytes)
  const files=new NativeTerminalFileSession(operations),processes=new NativeTerminalProcesses(operations,files)
  try{
    const pid=processes.call('process.spawn',[['cat','large.bin'],'/app',{}])
    let offset=0,chunks=0
    for(;;){
      const event=await processes.call('process.next',[pid])
      assert.ok(event)
      if(event.type==='exit'){assert.equal(event.code,0);break}
      assert.equal(event.type,'stdout')
      assert.deepEqual(event.bytes,bytes.subarray(offset,offset+event.bytes.length))
      chunks++;offset+=event.bytes.length
    }
    assert.equal(offset,bytes.length);assert.ok(chunks>1)
    assert.equal((await inspect()).descriptors,0)
  }finally{processes.close();files.close()}
}))

function mountProject(operations){
  const project=npmProject()
  for(const [path,text] of Object.entries(project.files)){
    const target='/app'+path
    operations.mkdirSync(target.slice(0,target.lastIndexOf('/')),{recursive:true})
    operations.writeFileSync(target,text)
  }
  const manifest=String(operations.readFileSync('/app/package.json')),
    lockText=String(operations.readFileSync('/app/package-lock.json'))
  const planned=planProjectInstall(manifest,lockText)
  const lock={version:1,packages:planned.lock.packages.map(pkg=>({...pkg,installPath:'/app'+pkg.installPath}))}
  return {...project,manifest,lockText,lock}
}
async function withArchives(project,fn,onFetch){
  const original=globalThis.fetch
  globalThis.fetch=async(url)=>{
    await onFetch?.()
    assert.ok(project.archives[url],'Only the owned package fixture may be fetched')
    return new Response(Uint8Array.from(project.archives[url]))
  }
  try{return await fn()}finally{globalThis.fetch=original}
}

test('live verified installation swaps the remote package tree without replacing project files',settings,()=>fixture(async({connect})=>{
  const writer=connect('installer'),reader=connect('reader'),project=mountProject(writer.operations)
  const result=await withArchives(project,()=>installLiveLockedPackages(writer.operations,project.lock,
    {expectedManifest:project.manifest,expectedLock:project.lockText}))
  assert.equal(result.installed,3)
  assert.equal(reader.operations.existsSync('/app/node_modules/stale'),false)
  assert.match(String(reader.operations.readFileSync('/app/node_modules/parent/index.js')),/require\("child"\)/)
  assert.equal(String(reader.operations.realpathSync('/app/node_modules/.bin/parent')),'/app/node_modules/parent/index.js')
  assert.equal(String(reader.operations.readFileSync('/app/keep.txt')),'keep')
  assert.ok(reader.operations.readdirSync('/app').every(name=>!String(name).startsWith('.native-install-')))
}))

test('failed refresh restores the remote package tree and selected shrinkwrap lockfile',settings,()=>fixture(async({connect})=>{
  const writer=connect('installer'),reader=connect('reader'),project=mountProject(writer.operations)
  writer.operations.writeFileSync('/app/npm-shrinkwrap.json',project.lockText)
  await withArchives(project,()=>assert.rejects(installLiveLockedPackages(writer.operations,project.lock,
    {expectedManifest:project.manifest,expectedLock:project.lockText,lockText:project.lockText+'\n',
      afterCommit:async()=>{throw Error('refresh failed')}}),/refresh failed/))
  assert.equal(String(reader.operations.readFileSync('/app/node_modules/stale/index.js')),'stale')
  assert.equal(String(reader.operations.readFileSync('/app/npm-shrinkwrap.json')),project.lockText)
  assert.equal(String(reader.operations.readFileSync('/app/package-lock.json')),project.lockText)
  assert.ok(reader.operations.readdirSync('/app').every(name=>!String(name).startsWith('.native-install-')))
}))

test('a manifest edit from another client rejects the remote staged install',settings,()=>fixture(async({connect})=>{
  const writer=connect('installer'),editor=connect('editor'),project=mountProject(writer.operations)
  await withArchives(project,()=>assert.rejects(installLiveLockedPackages(writer.operations,project.lock,
    {expectedManifest:project.manifest,expectedLock:project.lockText}),/changed during/),
    ()=>editor.operations.writeFileSync('/app/package.json',project.manifest+'\n'))
  assert.equal(String(editor.operations.readFileSync('/app/node_modules/stale/index.js')),'stale')
  assert.equal(String(editor.operations.readFileSync('/app/package.json')),project.manifest+'\n')
  assert.ok(editor.operations.readdirSync('/app').every(name=>!String(name).startsWith('.native-install-')))
}))
