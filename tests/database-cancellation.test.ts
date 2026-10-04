import {afterEach,expect,test,vi} from 'vitest'
import {openSandboxDatabase} from '../src/sandbox/database'
afterEach(()=>vi.unstubAllGlobals())
test('database open rejects exact abort reason and closes a late connection',async()=>{
  const request:any={}
  const open=vi.fn(()=>request)
  vi.stubGlobal('indexedDB',{open})
  const controller=new AbortController(),reason=Error('cancel open')
  const pending=openSandboxDatabase(controller.signal)
  const rejected=expect(pending).rejects.toBe(reason)
  controller.abort(reason)
  await rejected
  const close=vi.fn()
  request.result={close}
  request.onsuccess()
  expect(close).toHaveBeenCalledOnce()
})
test('already cancelled database open does not start an IndexedDB request',async()=>{
  const open=vi.fn()
  vi.stubGlobal('indexedDB',{open})
  const reason=Error('already cancelled')
  await expect(openSandboxDatabase(AbortSignal.abort(reason))).rejects.toBe(reason)
  expect(open).not.toHaveBeenCalled()
})
test('cancelled upgrade aborts its transaction without creating stores',async()=>{
  const request:any={result:{createObjectStore:vi.fn()},transaction:{abort:vi.fn()}}
  vi.stubGlobal('indexedDB',{open:()=>request})
  const controller=new AbortController(),reason=Error('cancel upgrade')
  const pending=openSandboxDatabase(controller.signal)
  const rejected=expect(pending).rejects.toBe(reason)
  controller.abort(reason)
  await rejected
  request.onupgradeneeded()
  expect(request.transaction.abort).toHaveBeenCalledOnce()
  expect(request.result.createObjectStore).not.toHaveBeenCalled()
})
