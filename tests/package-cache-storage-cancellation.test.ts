import {afterEach,expect,test,vi} from 'vitest'
import {readPackageRecord,writePackageRecord,deletePackageRecord} from '../src/npm/package-cache-storage'
const state=vi.hoisted(()=>({db:undefined as any}))
vi.mock('../src/sandbox/database',()=>({openSandboxDatabase:async()=>state.db}))
afterEach(()=>vi.unstubAllGlobals())
for(const operation of ['read','write','delete'] as const){
  test(`abort cancels a pending cache ${operation} transaction and closes its database`,async()=>{
    vi.stubGlobal('indexedDB',{})
    vi.stubGlobal('IDBKeyRange',{bound:()=>({})})
    const transaction:any={objectStore:()=>({get:()=>({}),put:()=>{},delete:()=>{},index:()=>({openKeyCursor:()=>({})})})}
    transaction.abort=vi.fn(()=>transaction.onabort?.())
    const close=vi.fn()
    state.db={transaction:()=>transaction,close}
    const controller=new AbortController(),reason=Error('cancel cache transaction')
    const pending=operation==='read'?readPackageRecord('archive','key',controller.signal):operation==='delete'?deletePackageRecord('archive','key',controller.signal):
      writePackageRecord({id:'archive:key',key:'key',kind:'archive',version:1,value:new ArrayBuffer(1),bytes:1,used:1},100,10,controller.signal)
    const rejected=expect(pending).rejects.toBe(reason)
    await Promise.resolve()
    controller.abort(reason)
    await rejected
    expect(transaction.abort).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
}
