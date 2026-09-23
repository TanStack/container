import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {startSnapshotStore,fingerprintStartWorkspace} from './start-workspace-persistence'

let server:Server,url:string
test.beforeAll(async()=>{
  server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Snapshot persistence test</title>')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  url=`http://127.0.0.1:${(server.address() as any).port}/`
})
test.afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))})

test('public snapshot bytes and metadata survive a real browser reload',async({page})=>{
  await page.addInitScript(`window.snapshotStore=${startSnapshotStore.toString()};window.snapshotFingerprint=${fingerprintStartWorkspace.toString()};`)
  await page.goto(url)
  const before=await page.evaluate(async()=>{
    const snapshot={version:5,files:{'/project/count.txt':new TextEncoder().encode('2'),'/project/node_modules/.vite/deps/react.js':new Uint8Array([0,255,1])},directories:['/project','/project/node_modules','/project/node_modules/.vite','/project/node_modules/.vite/deps'],symlinks:{'/project/link':'count.txt'},fileModes:{'/project/count.txt':0o644},directoryModes:{'/project':0o755}}
    await (window as any).snapshotStore({operation:'save',snapshot})
    return (window as any).snapshotFingerprint(snapshot)
  })
  await page.reload()
  const after=await page.evaluate(async()=>{
    const snapshot=await (window as any).snapshotStore({operation:'load'})
    const result={fingerprint:await (window as any).snapshotFingerprint(snapshot),typed:Object.values(snapshot.files).every(value=>value instanceof Uint8Array),count:new TextDecoder().decode(snapshot.files['/project/count.txt'])}
    await (window as any).snapshotStore({operation:'delete'})
    if(await (window as any).snapshotStore({operation:'load'})!==undefined)throw Error('Acceptance snapshot cleanup failed')
    return result
  })
  expect(after).toEqual({fingerprint:before,typed:true,count:'2'})
})
