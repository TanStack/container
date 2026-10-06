import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {installNativeFilesystemProvider,getNativeFilesystemProvider} from '../src/native/filesystem-provider.mjs'
import {installNativeFilesystemConnection,getNativeFilesystemConnection,linkNativeFilesystemWorker,
  receiveNativeFilesystemBootstrap,FILESYSTEM_BOOTSTRAP,FILESYSTEM_ATTACH,FILESYSTEM_DETACH} from '../src/native/filesystem-worker-link.mjs'
import {createFilesystemServiceControl} from '../src/native/filesystem-service-control.mjs'

test('all worker filesystem bootstraps register compiler access after installing the remote provider',()=>{
  const source=readFileSync(new URL('../src/native/filesystem-bootstrap.ts',import.meta.url),'utf8')
  const provider=source.indexOf('installNativeFilesystemProvider(createNativeFilesystemClientApi(')
  const registration=source.indexOf("await import('./compiler-filesystem')")
  assert.ok(provider>=0&&registration>provider,'Compiler filesystem registration cannot depend on loading Rolldown')
  assert.doesNotMatch(source,/@rolldown\/browser|rolldown-loading/,'Filesystem startup must stay compiler-free')
})

test('a filesystem provider cannot be replaced after handles have opened',()=>{
  const scope={},provider={fs:{},vol:{}}
  assert.equal(installNativeFilesystemProvider(provider,scope),provider)
  assert.equal(getNativeFilesystemProvider(scope),provider)
  assert.throws(()=>installNativeFilesystemProvider(provider,scope),/already installed/)
  assert.throws(()=>installNativeFilesystemProvider({},{}),/requires/)
})

test('child bootstrap transfers a direct owner connection and detaches once',()=>{
  const ownerMessages=[],childMessages=[]
  const connection={id:'main',control:{postMessage:(...args)=>ownerMessages.push(args)}}
  const link=linkNativeFilesystemWorker({postMessage:(...args)=>childMessages.push(args)},connection)
  try{
    assert.ok(link.id.startsWith('main/'))
    assert.equal(ownerMessages[0][0].type,FILESYSTEM_ATTACH)
    assert.equal(childMessages[0][0].type,FILESYSTEM_BOOTSTRAP)
    assert.equal(ownerMessages[0][0].id,childMessages[0][0].id)
    assert.equal(ownerMessages[0][1][0],ownerMessages[0][0].port)
    assert.equal(childMessages[0][1][0],childMessages[0][0].control)
    link.dispose();link.dispose()
    assert.deepEqual(ownerMessages[1],[{type:FILESYSTEM_DETACH,id:link.id}])
    assert.equal(ownerMessages.length,2)
  }finally{ownerMessages[0][0].port.close();childMessages[0][0].control.close()}
})

test('connections are immutable and standalone controls do not create another owner',()=>{
  const scope={},connection={id:'main',control:{postMessage(){}}}
  installNativeFilesystemConnection(connection,scope)
  assert.equal(getNativeFilesystemConnection(scope).id,'main')
  assert.throws(()=>installNativeFilesystemConnection(connection,scope),/already installed/)
  assert.equal(linkNativeFilesystemWorker({postMessage(){throw Error('unexpected worker message')}},null),undefined)
})

test('a classic bootstrap can deliver a connection queued before module imports',async()=>{
  const target=new EventTarget(),connection={type:FILESYSTEM_BOOTSTRAP,id:'classic',control:{postMessage(){}}}
  target[Symbol.for('tanstack-container:filesystem-bootstrap-v1')]=connection
  assert.equal(await receiveNativeFilesystemBootstrap(target,100),connection)
})

test('module bootstrap waits for its connection, rejects an absent owner and removes listeners',async()=>{
  const target=new EventTarget(),connection={type:FILESYSTEM_BOOTSTRAP,id:'module',control:{postMessage(){}}}
  const pending=receiveNativeFilesystemBootstrap(target,1000)
  target.dispatchEvent(new MessageEvent('message',{data:connection}))
  assert.equal(await pending,connection)
  await assert.rejects(receiveNativeFilesystemBootstrap(target,1),/timed out/)
})

test('releasing a child control closes descendants but keeps sibling controls',()=>{
  const released=[],forwarded=[]
  const service={releaseScope:id=>released.push(id),onMessage:event=>forwarded.push(event),dispose(){}}
  const router=createFilesystemServiceControl(service)
  const channels=['main/child','main/child/grandchild','main/sibling'].map(id=>{
    const {port1,port2}=new MessageChannel()
    router.onMessage({data:{type:FILESYSTEM_ATTACH,id,port:port1}})
    return {port1,port2}
  })
  try{
    assert.equal(router.inspect().controls,3)
    router.onMessage({data:{type:FILESYSTEM_DETACH,id:'main/child'}})
    assert.equal(router.inspect().controls,1)
    assert.deepEqual(released,['main/child'])
    const event={data:{type:'tanstack-wasi-filesystem-connect'}}
    router.onMessage(event);assert.equal(forwarded[0],event)
    router.dispose();assert.equal(router.inspect().controls,0)
  }finally{for(const {port1,port2}of channels){port1.close();port2.close()}}
})
