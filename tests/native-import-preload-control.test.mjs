import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const run=promisify(execFile)
test('Node ESM preloads await initialization, cache duplicates and follow CommonJS preloads',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'container-import-preload-control-'))
  const files={
    'require.cjs':'globalThis.preloadEvents=["require"];',
    'first.mjs':'globalThis.preloadEvents.push("first-start");await new Promise(resolve=>setTimeout(resolve,20));globalThis.preloadEvents.push("first-done");',
    'second.mjs':'globalThis.preloadEvents.push("second-done");',
    'entry.cjs':'globalThis.preloadEvents.push("entry");console.log(JSON.stringify(globalThis.preloadEvents));',
  }
  for(const [name,source] of Object.entries(files))await writeFile(join(directory,name),source,{flag:'wx'})
  const {stdout,stderr}=await run(process.execPath,[
    '--import=./first.mjs','--require','./require.cjs','--import',pathToFileURL(join(directory,'second.mjs')).href,
    '--import','./first.mjs','entry.cjs',
  ],{cwd:directory,timeout:10000})
  assert.equal(stderr,'')
  const events=JSON.parse(stdout)
  assert.equal(events[0],'require')
  assert.equal(events.at(-1),'entry')
  assert.deepEqual([...events].sort(),['entry','first-done','first-start','require','second-done'].sort())
  assert.ok(events.indexOf('first-start')<events.indexOf('first-done'))
  assert.ok(events.indexOf('first-done')<events.indexOf('second-done'))
})
