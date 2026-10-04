import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium,firefox,webkit} from '@playwright/test'

test('real cache transactions cancel while queued behind a live transaction',async()=>{
  const server=await createServer({server:{host:'127.0.0.1',port:0}})
  await server.listen()
  try{
    for(const type of [chromium,firefox,webkit]){
      const browser=await type.launch({headless:true})
      try{
        const page=await browser.newPage()
        await page.goto(server.resolvedUrls.local[0])
        const result=await page.evaluate(async()=>{
          const {openSandboxDatabase}=await import('/src/sandbox/database.ts')
          const {readPackageRecord,writePackageRecord,deletePackageRecord}=await import('/src/npm/package-cache-storage.ts')
          const key='cancel-test-'+crypto.randomUUID()
          const original={id:'archive:'+key,version:1,kind:'archive',key,value:new Uint8Array([7]).buffer,bytes:1,used:1}
          await writePackageRecord(original,1024,10)
          const outcomes=[]
          for(const operation of ['read','write','delete']){
            const db=await openSandboxDatabase()
            const transaction=db.transaction('package-cache','readwrite')
            const store=transaction.objectStore('package-cache')
            let hold=true
            const keepAlive=()=>{const request=store.get(original.id);request.onsuccess=()=>{if(hold)keepAlive()}}
            keepAlive()
            const complete=new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error)})
            const nativeTransaction=IDBDatabase.prototype.transaction
            let queued
            const ready=new Promise(resolve=>{queued=resolve})
            IDBDatabase.prototype.transaction=function(...args){
              const result=Reflect.apply(nativeTransaction,this,args)
              queued()
              return result
            }
            const controller=new AbortController(),reason=Error('cancel '+operation)
            const pending=operation==='read'?readPackageRecord('archive',key,controller.signal):operation==='delete'?deletePackageRecord('archive',key,controller.signal):
              writePackageRecord({...original,value:new Uint8Array([9]).buffer},1024,10,controller.signal)
            let exact=false
            const settled=pending.then(()=>false,error=>{exact=error===reason;return exact})
            // Observe the actual queued transaction rather than infer it from time.
            await ready
            IDBDatabase.prototype.transaction=nativeTransaction
            controller.abort(reason)
            const cancelled=await Promise.race([settled,new Promise(resolve=>setTimeout(()=>resolve(false),1000))])
            hold=false
            await complete
            db.close()
            const stored=await readPackageRecord('archive',key)
            outcomes.push({operation,cancelled,exact,value:[...new Uint8Array(stored.value)]})
          }
          // Remove only the record created by this test.
          await deletePackageRecord('archive',key)
          return outcomes
        })
        assert.deepEqual(result,['read','write','delete'].map(operation=>({operation,cancelled:true,exact:true,value:[7]})),type.name())
        console.log('cache transaction cancellation passed',type.name())
      }finally{await browser.close()}
    }
  }finally{await server.close()}
})
