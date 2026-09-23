import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseProcesses,ownedDescendants,ownerIsLive,ownedWebKitProcesses} from './sdk/helpers/owned-webkit-sample.mjs'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const rows=parseProcesses(` 10 1 Fri Sep 18 12:00:00 2026 /owned/MiniBrowser
11 10 Fri Sep 18 12:00:01 2026 /owned/WebContent
12 11 Fri Sep 18 12:00:02 2026 /owned/Networking
13 1 Fri Sep 18 12:00:02 2026 /owned/WebContent
14 15 Fri Sep 18 12:00:02 2026 /other/A
15 14 Fri Sep 18 12:00:02 2026 /other/B`)
test('only descendants of exact launched process qualify',()=>{
  assert.equal(rows.length,6)
  assert.deepEqual(ownedDescendants(rows,rows[0]).map(row=>row.pid),[11,12])
})
test('missing or reused anchor cannot establish ownership',()=>{
  assert.deepEqual(ownedDescendants(rows,undefined),[])
  assert.deepEqual(ownedDescendants(rows,{...rows[0],started:'different'}),[])
  assert.deepEqual(ownedDescendants(rows,{...rows[0],command:'/unrelated'}),[])
})
const workerRows=parseProcesses(`100 1 Fri Sep 18 12:00:00 2026 /node/bin/node
101 100 Fri Sep 18 12:00:01 2026 /webkit/MiniBrowser
102 101 Fri Sep 18 12:00:02 2026 /webkit/com.apple.WebKit.WebContent
103 101 Fri Sep 18 12:00:03 2026 /webkit/com.apple.WebKit.Networking
104 1 Fri Sep 18 12:00:04 2026 /webkit/com.apple.WebKit.WebContent
105 101 Fri Sep 18 12:00:05 2026 /webkit-other/com.apple.WebKit.WebContent
106 101 Fri Sep 18 12:00:06 2026 /webkit/not-a-webkit-process`)
const workerOwner={kind:'current-worker',pid:100,anchor:workerRows[0]}
test('standard worker ownership only permits exact live worker descendants in its WebKit bundle',()=>{
  assert.equal(ownerIsLive(workerRows,workerOwner,100),true)
  assert.deepEqual(ownedWebKitProcesses(workerRows,workerOwner,'/webkit',100).map(row=>row.pid),[102,103])
  assert.deepEqual(ownedWebKitProcesses(workerRows,workerOwner,'/webkit',999),[])
  assert.deepEqual(ownedWebKitProcesses(workerRows,{...workerOwner,pid:999},'/webkit',100),[])
  for(const field of ['started','command'])assert.deepEqual(ownedWebKitProcesses(workerRows,{...workerOwner,anchor:{...workerOwner.anchor,[field]:'changed'}},'/webkit',100),[])
  assert.deepEqual(ownedWebKitProcesses(workerRows.slice(1),workerOwner,'/webkit',100),[])
})
test('fresh ancestry drops reparented processes and broken parent chains',()=>{
  const reparented=workerRows.map(row=>row.pid===102?{...row,ppid:1}:row)
  assert.deepEqual(ownedWebKitProcesses(reparented,workerOwner,'/webkit',100).map(row=>row.pid),[103])
  assert.deepEqual(ownedWebKitProcesses(workerRows.filter(row=>row.pid!==101),workerOwner,'/webkit',100),[])
})
test('child ownership requires matching child identity and live exit state',()=>{
  const child={pid:101,exitCode:null,signalCode:null},owner={kind:'child',child,anchor:workerRows[1]}
  assert.equal(ownerIsLive(workerRows,owner),true)
  assert.equal(ownerIsLive(workerRows,{...owner,child:{...child,pid:999}}),false)
  assert.equal(ownerIsLive(workerRows,{...owner,child:{...child,exitCode:0}}),false)
  assert.equal(ownerIsLive(workerRows,{...owner,child:{...child,signalCode:'SIGTERM'}}),false)
  assert.equal(ownerIsLive(workerRows,{...owner,kind:'unknown'}),false)
})
test('standard mode keeps normal browser fixture identity and rejects combined modes',()=>{
  const source=`import {withOwnedWebKitProfile,standardProfileEnabled} from './tests/sdk/helpers/owned-webkit-fixture.mjs';const base={};if(!standardProfileEnabled||withOwnedWebKitProfile(base)!==base)throw Error('Normal fixture changed')`
  const env={...process.env,SDK_STANDARD_PROFILE:'1',SDK_OWNED_PROFILE:'0'}
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env,encoding:'utf8',timeout:5000})
  assert.equal(result.status,0,result.stderr)
  const combined=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{...env,SDK_OWNED_PROFILE:'1'},encoding:'utf8',timeout:5000})
  assert.notEqual(combined.status,0);assert.match(combined.stderr,/cannot be combined/)
})
test('sampling remains bounded and rechecks ownership for every candidate',()=>{
  const source=readFileSync(new URL('./sdk/helpers/owned-webkit-sample.mjs',import.meta.url),'utf8')
  assert.match(source,/\.slice\(0,2\)/)
  assert.match(source,/ownedWebKitProcesses\(await processSnapshot\(\),owner,bundleRoot\)/)
  assert.match(source,/String\(candidate.pid\),'2','10'/)
})
