import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs'
import {dirname,join,relative,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {compilerPackageInventory,stageCompilerPackage} from '../scripts/compiler-package-staging.mjs'
import {compilerInputPaths} from '../scripts/compiler-input-paths.mjs'

test('staged compiler inputs preserve byte identity across checkout and extraction paths',async()=>{
  const scratch=realpathSync(mkdtempSync(join(tmpdir(),'compiler-package-staging-')))
  const controls=[],outputs=[],identities=[]
  for(const name of ['first','second-with-a-longer-path']){
    const workspace=join(scratch,'workspaces',name),extracted=join(scratch,'extractions',name)
    mkdirSync(workspace,{recursive:true})
    cpSync('tests/fixtures/compiler-staged-package',extracted,{recursive:true})
    writeFileSync(join(workspace,'shared.cjs'),'module.exports=value=>value+41')
    const options=packageRoot=>({absWorkingDir:workspace,
      entryPoints:{first:join(packageRoot,'first.js'),second:join(packageRoot,'second.js')},
      outdir:join(workspace,'output'),outExtension:{'.js':'.mjs'},bundle:true,splitting:true,
      platform:'browser',format:'esm',target:'es2022',write:false,metafile:true,
      plugins:[{name:'workspace-compiler-input',setup(bundler){
        bundler.onResolve({filter:/^workspace:shared$/},args=>{
          assert.equal(args.namespace,'file')
          assert.ok(args.importer.startsWith(packageRoot+'/'))
          return {path:join(workspace,'shared.cjs')}
        })
      }}],
    })
    const control=await build(options(extracted))
    controls.push(control.outputFiles.map(file=>({path:relative(workspace+'/output',file.path),text:file.text})))
    const staged=stageCompilerPackage(extracted,workspace)
    identities.push({sha256:staged.sha256,files:staged.files,path:relative(workspace,staged.packageRoot)})
    assert.deepEqual(stageCompilerPackage(extracted,workspace),staged,'Verified input cache must be reusable')
    const result=await build(options(staged.packageRoot))
    outputs.push(result.outputFiles.map(file=>({path:relative(workspace+'/output',file.path),text:file.text})))
    assert.ok(Object.keys(result.metafile.inputs).some(name=>name.startsWith('(disabled):')))
    const paths=compilerInputPaths(workspace,result.metafile)
    assert.ok(paths.every(path=>existsSync(path)))
    assert.ok(paths.includes(join(workspace,'shared.cjs')))
    assert.ok(paths.includes(join(staged.packageRoot,'worker.ts')))
    for(const file of result.outputFiles){
      assert.ok(!file.text.includes(workspace)&&!file.text.includes(extracted),'Compiler output leaked its checkout or extraction path')
      mkdirSync(dirname(file.path),{recursive:true});writeFileSync(file.path,file.contents)
    }
    const first=await import(pathToFileURL(join(workspace,'output/first.mjs')))
    const second=await import(pathToFileURL(join(workspace,'output/second.mjs')))
    assert.equal(first.answer,42);assert.equal(second.answer,43)
    assert.equal(first.name,'WorkerValue');assert.equal(first.disabled,undefined)
  }
  assert.notDeepEqual(controls[0],controls[1],'Before control must expose different extraction labels and chunks')
  assert.deepEqual(identities[0],identities[1])
  assert.deepEqual(outputs[0],outputs[1],'Every compiler byte and chunk filename must match')
})

test('staged compiler inputs reject altered cache bytes without overwriting them',()=>{
  const scratch=realpathSync(mkdtempSync(join(tmpdir(),'compiler-input-cache-integrity-')))
  const source=join(scratch,'source'),workspace=join(scratch,'workspace')
  cpSync('tests/fixtures/compiler-staged-package',source,{recursive:true});mkdirSync(workspace)
  const staged=stageCompilerPackage(source,workspace)
  const altered=join(staged.packageRoot,'first.js')
  writeFileSync(altered,'changed by test')
  assert.throws(()=>stageCompilerPackage(source,workspace),/Staged compiler inputs changed/)
  assert.equal(readFileSync(altered,'utf8'),'changed by test')
})

test('compiler package staging refuses links and unexpected cache directory contents',()=>{
  const scratch=realpathSync(mkdtempSync(join(tmpdir(),'compiler-input-cache-boundary-')))
  const source=join(scratch,'source'),workspace=join(scratch,'workspace')
  cpSync('tests/fixtures/compiler-staged-package',source,{recursive:true});mkdirSync(workspace)
  const staged=stageCompilerPackage(source,workspace)
  writeFileSync(join(dirname(staged.packageRoot),'unexpected.txt'),'extra')
  assert.throws(()=>stageCompilerPackage(source,workspace),/unexpected entries/)
  symlinkSync(join(source,'first.js'),join(source,'linked.js'))
  assert.throws(()=>compilerPackageInventory(source),/symbolic link/)
  const other=join(scratch,'other-workspace');mkdirSync(other)
  symlinkSync(workspace+'/.toolchains',join(other,'.toolchains'))
  assert.throws(()=>stageCompilerPackage(resolve('tests/fixtures/compiler-staged-package'),other),/Invalid compiler input cache directory/)
})
