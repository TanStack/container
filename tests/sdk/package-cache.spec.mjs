import {test,expect} from '@playwright/test'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {npmProject} from '../fixtures/npm-project.ts'

let server,origin
const archive=Object.values(npmProject().archives)[0]
const integrity='sha512-'+createHash('sha512').update(archive).digest('base64')
test.beforeAll(async()=>{
  const bundled=await build({stdin:{contents:`
    import * as storage from './src/npm/package-cache-storage';
    import * as database from './src/sandbox/database';
    import {PackageInstallCache} from './src/npm/install';
    window.cacheFixture={...storage,...database,PackageInstallCache};
  `,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',external:['sha.js']})
  server=createServer((request,response)=>{
    if(request.url==='/cache.js'){response.setHeader('content-type','text/javascript');response.end(bundled.outputFiles[0].text)}
    else if(request.url==='/archive.tgz'){response.end(archive)}
    else{response.setHeader('content-type','text/html');response.end('<script type="module" src="/cache.js"></script>')}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  origin='http://127.0.0.1:'+server.address().port
})
test.afterAll(async()=>{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))})
test.beforeEach(async({page})=>{await page.goto(origin);await page.waitForFunction(()=>window.cacheFixture)})

test('package archive cache preserves cold, persisted and warm data without registry access',async({page})=>{
  const result=await page.evaluate(async integrity=>{
    const {PackageInstallCache}=window.cacheFixture
    let loads=0
    const load=async()=>{loads++;return new Uint8Array(await (await fetch('/archive.tgz')).arrayBuffer())}
    const first=new PackageInstallCache()
    await first.ready()
    const cold=await first.archive(integrity,load)
    const second=new PackageInstallCache()
    await second.ready()
    const persisted=await second.archive(integrity,load)
    const warm=await second.archive(integrity,load)
    return {loads,cold:[...cold],persisted:[...persisted],warm:[...warm]}
  },integrity)
  expect(result.loads).toBe(1)
  expect(result.cold).toEqual([...archive])
  expect(result.persisted).toEqual(result.cold)
  expect(result.warm).toEqual(result.cold)
})

test('metadata reads and eviction never materialize unrelated archive payloads',async({page})=>{
  const result=await page.evaluate(async()=>{
    const {writePackageRecord,loadPackageRecords,readPackageRecord}=window.cacheFixture
    const make=(kind,key,value,used)=>({id:kind+':'+key,version:1,kind,key,value,bytes:typeof value==='string'?value.length:value.byteLength,used})
    await writePackageRecord(make('archive','large',new ArrayBuffer(1024*1024),1),2*1024*1024,8)
    const originalGetAll=IDBObjectStore.prototype.getAll,originalIndexGetAll=IDBIndex.prototype.getAll
    let objectStoreReads=0,archiveValues=0
    IDBObjectStore.prototype.getAll=function(...args){objectStoreReads++;return originalGetAll.apply(this,args)}
    IDBIndex.prototype.getAll=function(...args){
      const request=originalIndexGetAll.apply(this,args)
      request.addEventListener('success',()=>{archiveValues+=request.result.filter(value=>value.kind==='archive').length})
      return request
    }
    try{
      await writePackageRecord(make('metadata','a','aa',2),4,2)
      await writePackageRecord(make('metadata','b','bb',3),4,2)
      await writePackageRecord(make('metadata','c','cc',4),4,2)
      await writePackageRecord(make('archive','small',new ArrayBuffer(2),5),2*1024*1024,8)
      const metadata=await loadPackageRecords('metadata')
      return {objectStoreReads,archiveValues,metadata:metadata.map(value=>value.key),archiveBytes:(await readPackageRecord('archive','large')).bytes}
    }finally{IDBObjectStore.prototype.getAll=originalGetAll;IDBIndex.prototype.getAll=originalIndexGetAll}
  })
  expect(result).toEqual({objectStoreReads:0,archiveValues:0,metadata:['b','c'],archiveBytes:1024*1024})
})

test('index eviction preserves byte, entry and deterministic tie limits',async({page})=>{
  const result=await page.evaluate(async()=>{
    const {writePackageRecord,loadPackageRecords,readPackageRecord,deletePackageRecord}=window.cacheFixture
    const put=(key,bytes,used,maxBytes=5,maxEntries=8)=>writePackageRecord({id:'archive:'+key,version:1,kind:'archive',key,value:new ArrayBuffer(bytes),bytes,used},maxBytes,maxEntries)
    await put('a',2,1);await put('b',2,2);await put('c',2,3)
    const byteKeys=(await loadPackageRecords('archive')).map(value=>value.key)
    await readPackageRecord('archive','b')
    await put('d',2,4,100,2)
    const entryKeys=(await loadPackageRecords('archive')).map(value=>value.key).sort()
    await put('oversized',101,5,100,2)
    const oversized=await readPackageRecord('archive','oversized')
    // Equal usage timestamps must use id ordering, not the bytes field in the index.
    await deletePackageRecord('archive','b');await deletePackageRecord('archive','d')
    await put('z',1,1,100,1);await put('y',3,1,100,1)
    const tieKeys=(await loadPackageRecords('archive')).map(value=>value.key).sort()
    return {byteKeys,entryKeys,oversized,tieKeys}
  })
  expect(result.byteKeys).toEqual(['b','c'])
  expect(result.entryKeys).toEqual(['b','d'])
  expect(result.oversized).toBeUndefined()
  expect(result.tieKeys).toEqual(['z'])
})

test('version two upgrade preserves checkpoint and archive records and adds accounting index',async({page})=>{
  const result=await page.evaluate(async()=>{
    const {sandboxDatabaseName,openSandboxDatabase,loadPackageRecords}=window.cacheFixture
    await new Promise((resolve,reject)=>{
      const request=indexedDB.open(sandboxDatabaseName,2)
      request.onupgradeneeded=()=>{
        request.result.createObjectStore('checkpoints')
        request.result.createObjectStore('package-cache',{keyPath:'id'}).createIndex('kind-used',['kind','used'])
      }
      request.onerror=()=>reject(request.error)
      request.onsuccess=()=>{
        const db=request.result,tx=db.transaction(['checkpoints','package-cache'],'readwrite')
        tx.objectStore('checkpoints').put({files:{'/keep.txt':'keep'}},'workspace')
        tx.objectStore('package-cache').put({id:'archive:old',version:1,kind:'archive',key:'old',value:new Uint8Array([1,2,3]).buffer,bytes:3,used:1})
        tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)
      }
    })
    const db=await openSandboxDatabase()
    const indexes=[...db.transaction('package-cache').objectStore('package-cache').indexNames]
    const checkpoint=await new Promise((resolve,reject)=>{
      const request=db.transaction('checkpoints').objectStore('checkpoints').get('workspace')
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)
    })
    db.close()
    return {indexes,checkpoint,archive:[...new Uint8Array((await loadPackageRecords('archive'))[0].value)]}
  })
  expect(result.indexes).toEqual(['kind-used','kind-used-bytes'])
  expect(result.checkpoint).toEqual({files:{'/keep.txt':'keep'}})
  expect(result.archive).toEqual([1,2,3])
})

test('invalid cached records are removed and archive integrity failures recover',async({page})=>{
  const result=await page.evaluate(async integrity=>{
    const {openSandboxDatabase,PackageInstallCache,loadPackageRecords}=window.cacheFixture
    const db=await openSandboxDatabase()
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('package-cache','readwrite'),store=tx.objectStore('package-cache')
      store.put({id:'metadata:broken',version:1,kind:'metadata',key:'broken',value:'x',bytes:10,used:1})
      store.put({id:'archive:'+integrity,version:1,kind:'archive',key:integrity,value:new Uint8Array([0]).buffer,bytes:1,used:1})
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)
    })
    db.close()
    const cache=new PackageInstallCache();await cache.ready()
    let loads=0
    const recovered=await cache.archive(integrity,async()=>{loads++;return new Uint8Array(await (await fetch('/archive.tgz')).arrayBuffer())})
    return {loads,recovered:[...recovered],metadata:await loadPackageRecords('metadata')}
  },integrity)
  expect(result.loads).toBe(1)
  expect(result.recovered).toEqual([...archive])
  expect(result.metadata).toEqual([])
})
