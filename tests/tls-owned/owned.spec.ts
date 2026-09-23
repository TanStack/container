import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const build=JSON.parse(readFileSync('public/tls-probe/build.json','utf8'))
const identity=Object.fromEntries([['ca','ca.pem'],['cert','server.pem'],['key','server-key.pem']].map(([name,file])=>[name,readFileSync(build.directory+'/'+file,'utf8')]))

for(const version of [12,13])test(`TLS ${version}: isolated owners, concurrent connections and disposal`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({identity,version})=>{
    const backendPath='/src/sandbox/tls-backend.ts',workflowPath='/fixtures/tls-owned-workflow.mjs'
    const {TLSBackend}=await import(/* @vite-ignore */backendPath)
    const {ownedWorkflow}=await import(/* @vite-ignore */workflowPath)
    return ownedWorkflow(new TLSBackend(undefined,2),identity,version)
  },{identity,version})
  await info.attach('tls-owned.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.denials).toBe(36)
  expect(result.survivor).toBe(true)
  expect(result.staleHandlesRejected).toBe(true)
})

test('closing a loading owner reserves capacity until its module is released',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const backendPath='/src/sandbox/tls-backend.ts',modulePath='/tls-runtime/tls.mjs'
    const {TLSBackend,loadTLSFactory}=await import(/* @vite-ignore */backendPath)
    const create=await loadTLSFactory()
    let resume!:()=>void
    const gate=new Promise<void>(resolve=>resume=resolve)
    const backend=new TLSBackend(async()=>{await gate;return create()},1)
    const opening=backend.createOwner(1).then(()=>'',(error:{code:string})=>error.code)
    const closing=backend.closeOwner(1)
    const whileClosing=await backend.createOwner(2).then(()=>'',(error:{code:string})=>error.code)
    resume();await closing
    const cancelled=await opening
    await backend.createOwner(2)
    const stats=backend.stats(2)
    await backend.closeOwner(2)
    return {whileClosing,cancelled,stats}
  })
  await info.attach('tls-owner-cancellation.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.whileClosing).toBe('EMFILE')
  expect(result.cancelled).toBe('ECANCELED')
  expect(result.stats.connections).toBe(0)
})

test('owner quotas and malformed inputs fail without leaving handles',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async identity=>{
    const backendPath='/src/sandbox/tls-backend.ts'
    const {TLSBackend}=await import(/* @vite-ignore */backendPath)
    const backend=new TLSBackend()
    const initialization=await backend.createOwner(1,{maxBytes:65536}).then(()=>'',(error:{code:string})=>error.code)
    await backend.createOwner(1,{maxBytes:196608})
    let quota=''
    try{backend.open(1,{servername:'localhost',ca:identity.ca})}catch(error){quota=(error as {code:string}).code}
    const afterQuota=backend.stats(1)
    await backend.closeOwner(1)
    await backend.createOwner(1)
    let malformed='',invalid=''
    try{backend.open(1,{servername:'localhost',ca:'not a certificate'})}catch(error){malformed=(error as {code:string}).code}
    try{backend.open(1,{servername:'localhost\0untrusted',ca:identity.ca})}catch(error){invalid=(error as {code:string}).code}
    const afterErrors=backend.stats(1)
    const connection=backend.open(1,{server:true,cert:identity.cert,key:identity.key})
    backend.destroy(1,connection)
    await backend.closeOwner(1)
    return {initialization,quota,afterQuota,malformed,invalid,afterErrors}
  },identity)
  await info.attach('tls-owner-limits.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.initialization).toBe('ERR_RESOURCE_LIMIT')
  expect(result.quota).toBe('ERR_TLS_BACKEND')
  expect(result.afterQuota.connections).toBe(0)
  expect(result.afterQuota.peak).toBeLessThanOrEqual(result.afterQuota.maxBytes)
  expect(result.malformed).toBe('ERR_TLS_BACKEND')
  expect(result.invalid).toBe('EINVAL')
  expect(result.afterErrors.connections).toBe(0)
})
