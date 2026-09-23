import {afterEach,expect,test,vi} from 'vitest'
import {openSandboxDatabase,sandboxDatabaseName,sandboxDatabaseVersion} from '../src/sandbox/database'

afterEach(()=>vi.unstubAllGlobals())

function databaseOpen(){
  const database:{close:ReturnType<typeof vi.fn>;onversionchange:((event:IDBVersionChangeEvent)=>void)|null;objectStoreNames:{contains:()=>boolean}}={close:vi.fn(),onversionchange:null,objectStoreNames:{contains:()=>true}}
  const request:{result:typeof database;error:null;onupgradeneeded:((event:Event)=>void)|null;onsuccess:((event:Event)=>void)|null;onerror:((event:Event)=>void)|null;onblocked:((event:Event)=>void)|null}={result:database,error:null,onupgradeneeded:null,onsuccess:null,onerror:null,onblocked:null}
  const open=vi.fn(()=>request)
  vi.stubGlobal('indexedDB',{open})
  return {database,request,open}
}

test('database connections close when another tab requests a schema upgrade',async()=>{
  const {database,request,open}=databaseOpen()
  const pending=openSandboxDatabase()
  request.onsuccess!({} as Event)
  await expect(pending).resolves.toBe(database)
  expect(open).toHaveBeenCalledWith(sandboxDatabaseName,sandboxDatabaseVersion)
  expect(database.onversionchange).toBeTypeOf('function')
  database.onversionchange!({} as IDBVersionChangeEvent)
  expect(database.close).toHaveBeenCalledOnce()
})

test('a blocked open rejects and closes a connection that succeeds later',async()=>{
  const {database,request}=databaseOpen()
  const pending=openSandboxDatabase()
  request.onblocked!({} as Event)
  await expect(pending).rejects.toThrow('blocked')
  request.onsuccess!({} as Event)
  expect(database.close).toHaveBeenCalledOnce()
})

test('schema upgrade preserves existing stores and creates package cache and kernel checkpoint stores',async()=>{
  const created:string[]=[]
  const packageStore={createIndex:vi.fn(),indexNames:{contains:()=>false}}
  const database={
    close:vi.fn(),onversionchange:null,
    objectStoreNames:{contains:(name:string)=>name==='checkpoints'},
    createObjectStore:vi.fn((name:string)=>{created.push(name);return packageStore}),
  }
  const request={result:database,transaction:{objectStore:vi.fn(()=>packageStore)},error:null,onupgradeneeded:null as ((event:Event)=>void)|null,onsuccess:null as ((event:Event)=>void)|null,onerror:null as ((event:Event)=>void)|null,onblocked:null as ((event:Event)=>void)|null}
  vi.stubGlobal('indexedDB',{open:()=>request})
  const pending=openSandboxDatabase()
  request.onupgradeneeded!({} as Event)
  request.onsuccess!({} as Event)
  await pending
  expect(created).toEqual(['checkpoint-manifests','checkpoint-blobs','package-cache'])
  expect(packageStore.createIndex).toHaveBeenCalledWith('kind-used',['kind','used'])
  expect(packageStore.createIndex).toHaveBeenCalledWith('kind-used-bytes',['kind','used','bytes'])
})
