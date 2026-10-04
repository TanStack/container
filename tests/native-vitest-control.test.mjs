import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile} from 'node:fs/promises'
test('Node completes the same one-test Vitest run',{timeout:10000},async()=>{
  const root=new URL('../',import.meta.url)
  const vitest=JSON.parse(await readFile(new URL('node_modules/vitest/package.json',root),'utf8'))
  const vite=JSON.parse(await readFile(new URL('node_modules/vite/package.json',root),'utf8'))
  assert.equal(vitest.version,'3.2.7')
  assert.equal(vite.version,'7.3.6')
  const {stdout,stderr}=await promisify(execFile)(process.execPath,[new URL('node_modules/vitest/vitest.mjs',root).pathname,'run',...(process.env.NATIVE_VITEST_POOL==='threads'?['--pool=threads']:[])],{
    cwd:new URL('./fixtures/native-vitest-control/',import.meta.url),timeout:8000,
  })
  assert.match(stdout,/1 passed/)
  assert.equal(stderr,'')
})
