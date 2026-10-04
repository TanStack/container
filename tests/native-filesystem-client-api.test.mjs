import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {AsyncLocalStorage,AsyncResource} from 'node:async_hooks'
import {fs as constructors} from 'memfs'
import {createNativeFilesystemClientApi} from '../src/native/filesystem-client-api.mjs'
import {withNativeFilesystemService} from './fixtures/native-filesystem-service.mjs'
import {runFilesystemAsyncControl} from './fixtures/native-filesystem-async-workload.mjs'
import {runFilesystemStreamControl} from './fixtures/native-filesystem-stream-workload.mjs'
import {WRITE_FILE_WITH_PARENTS} from '../src/native/filesystem-write-protocol.mjs'

const settings={timeout:15000}
async function fixture(fn,options={}){
  await withNativeFilesystemService(async({connect,inspect})=>{
    const connection=connect('client'),observer=connect('observer')
    const client=createNativeFilesystemClientApi(connection.fs,constructors,connection.endpoint.port,options)
    try{await fn(client,observer.fs,inspect)}finally{client.dispose()}
  },options)
}

for(const codecVersion of ['1.1.4','1.2.4'])test(`the complete async and stream workloads use the remote namespace, codec ${codecVersion}`,settings,()=>fixture(async(client,observer,inspect)=>{
  const {fs,vol}=client
  assert.equal((await runFilesystemAsyncControl(vol,{callbacks:fs,promises:fs.promises})).checks.length,14)
  assert.equal((await runFilesystemStreamControl(fs,fs)).checks.length,14)
  fs.writeFileSync('/app/shared','visible')
  assert.equal(observer.readFileSync('/app/shared','utf8'),'visible')
  observer.writeFileSync('/app/shared','changed')
  assert.equal(fs.readFileSync('/app/shared','utf8'),'changed')
  assert.equal(vol.readFileSync('/app/shared','utf8'),'changed')
  assert.equal(fs.constants,constructors.constants)
  assert.equal(fs.realpathSync.native,fs.realpathSync)
  assert.equal(Object.hasOwn(vol,'_core'),false)
  assert.equal(typeof vol.opendirSync,'function')
  assert.equal((await inspect()).descriptors,0)
},{codecVersion}))

for(const codecVersion of ['1.1.4','1.2.4'])test(`checked file writes use one owner request, codec ${codecVersion}`,settings,()=>withNativeFilesystemService(async({connect,inspect,releaseScope})=>{
  const connection=connect('client'),observer=connect('observer')
  const requests=[]
  const raw=new Proxy(connection.fs,{get(target,key){
    const original=Reflect.get(target,key)
    if(typeof original!=='function')return original
    return (...args)=>{requests.push(key);return Reflect.apply(original,target,args)}
  }})
  const client=createNativeFilesystemClientApi(raw,constructors,connection.endpoint.port)
  try{
    assert.equal(Object.hasOwn(client.fs,'writeFileWithParentsSync'),false)
    const source=new Uint8Array([8,0,127,255,9]),contents=source.subarray(1,4)
    client.vol.writeFileWithParentsSync('nested/program',contents,{followSymlinks:false,mode:0o755})
    assert.deepEqual(requests,[WRITE_FILE_WITH_PARENTS])
    assert.deepEqual([...observer.fs.readFileSync('/app/nested/program')],[0,127,255])
    assert.equal(observer.fs.statSync('/app/nested/program').mode&0o777,0o755)
    assert.deepEqual([...source],[8,0,127,255,9])
    client.vol.writeFileWithParentsSync('/app/nested/program',new Uint8Array([1]),{followSymlinks:false,mode:0o644})
    assert.equal(observer.fs.statSync('/app/nested/program').mode&0o777,0o755)
    assert.deepEqual([...observer.fs.readFileSync('/app/nested/program')],[1])
    observer.fs.writeFileSync('/app/not-directory','file')
    assert.throws(()=>client.vol.writeFileWithParentsSync('/app/not-directory/file',contents,{followSymlinks:false}),error=>error.code==='ENOTDIR')
    assert.throws(()=>client.vol.writeFileWithParentsSync('/',contents),/workspace root/)
    assert.equal(requests.length,4)
    assert.deepEqual(client.changedPaths('client'),['/app/nested','/app/nested/program'])
    await releaseScope('client')
    assert.equal((await inspect()).descriptors,0)
  }finally{client.dispose()}
},{codecVersion}))

test('path normalization accepts URLs and buffers and preserves relative link targets',settings,()=>fixture(async({fs},observer)=>{
  fs.mkdirSync('nested')
  fs.writeFileSync(Buffer.from('buffer.txt'),'buffer')
  fs.writeFileSync(new URL('file:///app/url.txt'),'url')
  fs.symlinkSync(Buffer.from('buffer.txt'),new URL('file:///app/link'))
  assert.equal(observer.readFileSync('/app/buffer.txt','utf8'),'buffer')
  assert.equal(observer.readFileSync('/app/url.txt','utf8'),'url')
  assert.equal(observer.readlinkSync('/app/link'),'buffer.txt')
  assert.throws(()=>fs.readFileSync(new URL('https://example.com/file')),error=>error.code==='ERR_INVALID_URL_SCHEME')
  assert.throws(()=>fs.readFileSync(new URL('file:///app/a%2Fb')),error=>error.code==='ERR_INVALID_FILE_URL_PATH')
  assert.throws(()=>fs.readFileSync('/app/a\0b'),error=>error.code==='ERR_INVALID_ARG_VALUE')
}))

test('a client reads cwd again after a process directory change',settings,async()=>{
  let directory='/app'
  await fixture(async({fs},observer)=>{
    fs.mkdirSync('/app/nested');fs.writeFileSync('before','one')
    directory='/app/nested';fs.writeFileSync('after','two')
    assert.equal(observer.readFileSync('/app/before','utf8'),'one')
    assert.equal(observer.readFileSync('/app/nested/after','utf8'),'two')
    const entries=await Array.fromAsync(fs.promises.glob('*'))
    assert.deepEqual(entries,['after'])
  },{cwd:()=>directory})
})

test('namespace watchers observe another endpoint and disposal leaves file operations intact',settings,()=>fixture(async(client,observer,inspect)=>{
  const {fs}=client
  fs.writeFileSync('/app/watched','before')
  const watcher=fs.watch('/app/watched',{encoding:'buffer',persistent:false})
  const changed=once(watcher,'change',{signal:AbortSignal.timeout(3000)})
  observer.writeFileSync('/app/watched','after')
  const [event,name]=await changed
  assert.equal(event,'change');assert.ok(Buffer.isBuffer(name));assert.equal(name.toString(),'watched')
  const closed=once(watcher,'close',{signal:AbortSignal.timeout(3000)})
  client.dispose();await closed;fs.statSync('/app/watched')
  assert.equal((await inspect()).watches,0)
  assert.equal(fs.readFileSync('/app/watched','utf8'),'after')
  assert.throws(()=>fs.watch('/app/watched'),/disposed/)
}))

test('callbacks retain async context and queued file work releases command activity',settings,async()=>{
  const store=new AsyncLocalStorage(),resources=[],activity=[]
  let active=0
  await fixture(async({fs},observer)=>{
    const result=store.run('created',()=>new Promise(resolve=>fs.stat('/missing',error=>{
      assert.equal(store.getStore(),'created');assert.equal(error.code,'ENOENT');resolve()
    })))
    assert.equal(active,1)
    await store.run('other',()=>result)
    assert.equal(active,0)
    assert.throws(()=>fs.stat('/app'),TypeError);assert.equal(active,0)
    const stream=fs.createWriteStream('/app/activity')
    const closed=once(stream,'close',{signal:AbortSignal.timeout(3000)})
    stream.end('complete');await closed
    assert.equal(observer.readFileSync('/app/activity','utf8'),'complete')
    assert.equal(active,0);assert.ok(activity.length>2);assert.ok(resources.length>1)
  },{createAsyncResource:name=>{const resource=new AsyncResource(name);resources.push(resource);return resource},
    keepAlive:()=>{active++;activity.push('start');let done=false;return ()=>{assert.equal(done,false);done=true;active--;activity.push('end')}}})
})
