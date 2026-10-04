import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {nativeAppForkFiles,nativeAppForkExpected} from './fixtures/native-app-fork.mjs'
test('app module forks inherit closed input and normal descriptors in Node',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'container-app-fork-'))
  for(const [path,source] of Object.entries(nativeAppForkFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
  const result=spawnSync(process.execPath,['-e','import("./app-fork-parent.mjs").then(({result})=>console.log(JSON.stringify(result)))'],{cwd:directory,input:'',encoding:'utf8',timeout:10000})
  assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.stderr,'')
  assert.deepEqual(JSON.parse(result.stdout),nativeAppForkExpected)
})
