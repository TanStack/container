import assert from 'node:assert/strict'
import {mkdtemp,writeFile,mkdir,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readFileSync} from 'node:fs'
import {viteResolvePlugin} from 'rolldown/experimental'
import {probeCallableResolver} from './fixtures/native-callable-resolver.mjs'

const root=await realpath(await mkdtemp(join(tmpdir(),'node-callable-resolver-files-')))
await mkdir(join(root,'fixture'))
await writeFile(join(root,'fixture','package.json'),JSON.stringify({type:'module',imports:{'#target':'./target.js'}}),{flag:'wx'})
await writeFile(join(root,'fixture','index.js'),'export {}',{flag:'wx'})
await writeFile(join(root,'fixture','target.js'),'export const answer = 42',{flag:'wx'})
const result=await probeCallableResolver(viteResolvePlugin,{root,readPackage:path=>readFileSync(path,'utf8')})
assert.equal(result.results.length,18)
assert.equal(result.callbacks,9)
assert.deepEqual(result.failures,[])
console.log(JSON.stringify({node:process.version,kind:'native-rolldown-reference',result,passed:true}))
