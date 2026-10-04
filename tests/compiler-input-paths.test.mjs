import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {existsSync,mkdtempSync,cpSync,realpathSync} from 'node:fs'
import {join,relative} from 'node:path'
import {tmpdir} from 'node:os'
import {compilerInputPaths} from '../scripts/compiler-input-paths.mjs'

test('actual browser-disabled esbuild inputs are not treated as package files',async()=>{
  const result=await build({stdin:{contents:'import inspect from "object-inspect";console.log(inspect({ok:true}))',resolveDir:process.cwd()},bundle:true,platform:'browser',write:false,metafile:true})
  assert.ok(Object.keys(result.metafile.inputs).some(name=>name.startsWith('(disabled):')))
  const paths=compilerInputPaths(process.cwd(),result.metafile).filter(name=>!name.endsWith('<stdin>'))
  assert.ok(paths.some(name=>name.endsWith('object-inspect/index.js')))
  assert.ok(paths.every(name=>existsSync(name)))
  assert.throws(()=>compilerInputPaths(process.cwd(),{inputs:{'(disabled):invalid':{bytes:1}}}),/contains bytes/)
})

test('package-root builds keep chunk hashes stable and input paths accurate across extraction directories',async()=>{
  const scratch=realpathSync(mkdtempSync(join(tmpdir(),'compiler-package-roots-')))
  const results=[]
  for(const name of ['first-extraction','second-extraction']){
    const root=join(scratch,name),output=join(root,'output')
    cpSync('tests/fixtures/compiler-package-build',root,{recursive:true})
    const result=await build({absWorkingDir:root,entryPoints:['first.js','second.js'],
      outdir:output,bundle:true,splitting:true,format:'esm',write:false,metafile:true})
    const inputs=compilerInputPaths(root,result.metafile)
    assert.equal(inputs.length,3)
    assert.ok(inputs.every(path=>existsSync(path)&&path.startsWith(root+'/')))
    results.push(result.outputFiles.map(file=>({path:relative(output,file.path),text:file.text})))
  }
  assert.deepEqual(results[0],results[1])
})
