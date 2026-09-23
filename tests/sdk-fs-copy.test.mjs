import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {inspectSDKFSCopy} from '../scripts/verify-sdk.mjs'
test('copy compatibility declaration requires both actual builtin export surfaces',()=>{
  const root=mkdtempSync(join(tmpdir(),'sdk-copy-manifest-')),directory=join(root,'runtime/kernel-runtime')
  mkdirSync(directory,{recursive:true})
  const modules={'node:fs':{exports:['cp','cpSync'],cjs:'fixture'},'node:fs/promises':{exports:['cp'],cjs:'fixture'}}
  const save=()=>writeFileSync(join(directory,'builtins.json'),JSON.stringify({modules}))
  save();const value=inspectSDKFSCopy(root)
  assert.equal(value.status,'subset');assert.equal(value.entrypoints.length,3)
  assert.ok(value.unsupported.includes('preserveTimestamps:true'))
  modules['node:fs/promises'].exports=[];save()
  assert.throws(()=>inspectSDKFSCopy(root),/Missing packaged filesystem copy exports/)
})
