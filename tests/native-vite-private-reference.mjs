import assert from 'node:assert/strict'
import {mkdtemp,writeFile,mkdir,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {createServer} from 'vite'
import {rolldown} from 'rolldown'
import {nativeVitePrivateFiles,probeVitePrivateImports} from './fixtures/native-vite-private-imports.mjs'

const root=await realpath(await mkdtemp(join(tmpdir(),'node-vite-private-files-')))
for(const [path,contents] of Object.entries(nativeVitePrivateFiles)){
  await mkdir(dirname(join(root,path)),{recursive:true})
  await writeFile(join(root,path),contents,{flag:'wx'})
}
const result=await probeVitePrivateImports(createServer,{root,rolldown,cold:process.env.NATIVE_VITE_PRIVATE_COLD==='1',
  report:state=>console.log(JSON.stringify({phase:state.events.at(-1)}))})
console.log(JSON.stringify({kind:'native-vite-private-reference',node:process.version,result,passed:result.passed}))
assert.equal(result.passed,true)
assert.equal(result.builtinMatched,true)
