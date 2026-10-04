import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {nativeWorkerPreloadFiles,nativeWorkerPreloadExpected,nativeWorkerPreloadFlags,nativeWorkerNestedPreloadExpected} from './fixtures/native-worker-preloads.mjs'

test('worker preload order matches real Node',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'container-worker-preloads-'))
  for(const [path,source] of Object.entries(nativeWorkerPreloadFiles))await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
  for(const [args,expected] of [[['preload-parent.cjs'],nativeWorkerPreloadExpected],[[...nativeWorkerPreloadFlags,'preload-inherited-parent.cjs'],nativeWorkerPreloadExpected],[[...nativeWorkerPreloadFlags,'preload-nested-parent.cjs'],nativeWorkerNestedPreloadExpected]]){
    const result=spawnSync(process.execPath,args,{cwd:directory,encoding:'utf8',timeout:10000})
    assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.stderr,'')
    assert.deepEqual(JSON.parse(result.stdout),expected)
  }
})
