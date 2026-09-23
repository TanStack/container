import {test,expect} from '@playwright/test'

test('worker file sessions share edits, isolate descriptors and revoke after restore',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/input':'old'})
    try{
      const writer=await kernel.openFileSession({writable:true}),reader=await kernel.openFileSession()
      const fd=await writer.call('open',['/project/input','r+'])
      const denied=await reader.call('read',[fd,3]).then(()=>false,error=>String(error).includes('EBADF'))
      const readOnly=await reader.call('open',['/project/new','w']).then(()=>false,error=>String(error).includes('read-only'))
      await writer.call('write',[fd,new TextEncoder().encode('new')])
      const shared=await kernel.readText('/project/input')
      await writer.close();await writer.close()
      const closed=await writer.call('stat',['/project/input']).then(()=>false,error=>String(error).includes('closed'))
      const readfd=await reader.call('open',['/project/input','r'])
      const bytes=Array.from(await reader.call('read',[readfd,3]) as Uint8Array)
      const snapshot=await kernel.snapshot();await kernel.restore(snapshot)
      const revoked=await reader.call('fstat',[readfd]).then(()=>false,error=>String(error).includes('closed'))
      const fresh=await kernel.openFileSession()
      const size=(await fresh.call('stat',['/project/input'])).size
      const stillRevoked=await reader.call('stat',['/project/input']).then(()=>false,error=>String(error).includes('closed'))
      await reader.close()
      await fresh.close()
      return {denied,readOnly,shared,closed,bytes,revoked,size,stillRevoked}
    }finally{kernel.close()}
  })
  expect(result).toEqual({denied:true,readOnly:true,shared:'new',closed:true,bytes:[110,101,119],revoked:true,size:3,stillRevoked:true})
})
