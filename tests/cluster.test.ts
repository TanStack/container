import {expect,test} from 'vitest'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'

test('native cluster control records ordinary process lifecycle ordering',()=>{
  const result=spawnSync(process.execPath,['tests/fixtures/node-cluster.mjs'],{encoding:'utf8'})
  expect(result.status,result.stderr).toBe(0)
  const value=JSON.parse(result.stdout)
  expect(value).toMatchObject({id:1,isDead:true,primary:true,master:true,constants:[1,2]})
  expect(value.events).toEqual(['online','message:ready','disconnect','exit:0:null'])
})

test('guest cluster stays process-backed and enables only sandbox-local shared listeners',()=>{
  const source=readFileSync('src/sandbox/guest-cluster.js','utf8'),builtins=readFileSync('src/compiler/builtins.ts','utf8'),report=JSON.parse(readFileSync('compat/node-cluster-feasibility.json','utf8'))
  expect(source).toContain("from 'node:child_process'");expect(source).not.toContain('worker_threads')
  expect(source).toContain('NODE_UNIQUE_ID');expect(builtins).toContain("'node:cluster':clusterSource")
  expect(report).toMatchObject({status:'implemented-sandbox-local',implemented:true,sharedListeners:true})
})
