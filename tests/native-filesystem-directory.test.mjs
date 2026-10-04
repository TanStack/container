import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import {mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fs as constructors} from 'memfs'
import {withNativeFilesystemService} from './fixtures/native-filesystem-service.mjs'
import {createNativeFilesystemClientApi} from '../src/native/filesystem-client-api.mjs'
import {runDirectoryControl} from './fixtures/native-filesystem-directory-workload.mjs'
import {AsyncLocalStorage,AsyncResource} from 'node:async_hooks'

test('real Node directory-handle reference',async()=>{
  const root=join(mkdtempSync(join(tmpdir(),'native-directory-reference-')),'work')
  const result=await runDirectoryControl(nodeFs,root)
  assert.equal(result.passed,true)
  console.log(JSON.stringify({scope:'Node reference',...result}))
})

test('endpoint scope release closes abandoned directories without closing a sibling',{timeout:15000},async()=>{
  await withNativeFilesystemService(async({connect,inspect,releaseScope})=>{
    const clients=['parent','parent/child','sibling'].map(id=>{
      const {fs,endpoint}=connect(id)
      return createNativeFilesystemClientApi(fs,constructors,endpoint.port)
    })
    const directories=clients.map(client=>client.fs.opendirSync('/app',{bufferSize:1}))
    assert.equal((await inspect()).directories,3)
    await releaseScope('parent')
    assert.equal((await inspect()).directories,1)
    assert.equal(directories[2].readSync(),null)
    clients[2].dispose()
    assert.equal((await inspect()).directories,0)
    assert.throws(()=>directories[2].readSync(),{code:'ERR_DIR_CLOSED'})
    assert.throws(()=>clients[2].fs.opendirSync('/app'),/disposed/)
    // Dead consumers cannot call their released port. The service, not their
    // JavaScript finalizers, closed both abandoned owner handles above.
  })
})

test('directory callbacks retain async context and release queued activity',{timeout:15000},async()=>{
  await withNativeFilesystemService(async({connect,inspect})=>{
    const {fs,endpoint}=connect('context'),store=new AsyncLocalStorage()
    let active=0
    const client=createNativeFilesystemClientApi(fs,constructors,endpoint.port,{
      createAsyncResource:name=>new AsyncResource(name),
      keepAlive:()=>{active++;return ()=>active--},
    })
    try{
      const directory=client.fs.opendirSync('/app',{bufferSize:1})
      const read=store.run('read',()=>new Promise((resolve,reject)=>directory.read((error,value)=>{
        assert.equal(store.getStore(),'read');error?reject(error):resolve(value)
      })))
      const close=store.run('close',()=>new Promise((resolve,reject)=>directory.close(error=>{
        assert.equal(store.getStore(),'close');error?reject(error):resolve()
      })))
      assert.equal(active,2)
      await Promise.all([read,close]);assert.equal(active,0)
      assert.equal((await inspect()).directories,0)
      const abandoned=client.fs.opendirSync('/app')
      const pending=abandoned.read()
      client.dispose();await assert.rejects(pending,{code:'ERR_DIR_CLOSED'})
      assert.equal(active,0);assert.equal((await inspect()).directories,0)
    }finally{client.dispose()}
  })
})

for(const codecVersion of ['1.1.4','1.2.4'])test('remote directory handles match Node, codec '+codecVersion,{timeout:15000},async()=>{
  await withNativeFilesystemService(async({connect,inspect})=>{
    const connection=connect('directory-client')
    const client=createNativeFilesystemClientApi(connection.fs,constructors,connection.endpoint.port)
    try{
      const result=await runDirectoryControl(client.fs,'/app/directories')
      assert.equal(result.passed,true)
      assert.equal((await inspect()).directories,0)
      console.log(JSON.stringify({scope:'Remote filesystem',codecVersion,...result}))
    }finally{client.dispose()}
  },{codecVersion})
})
