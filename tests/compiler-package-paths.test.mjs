import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {canonicalCompilerPackageRoot,isCompilerPackageImporter} from '../scripts/compiler-package-paths.mjs'

test('compiler binding importer checks use canonical paths and exact directory boundaries',async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'compiler-package-paths-'))
  try{
    const directory=join(scratch,'package'),alias=join(scratch,'package-alias')
    await mkdir(directory)
    await symlink(directory,alias,'dir')
    const canonical=await canonicalCompilerPackageRoot(directory)
    assert.equal(await canonicalCompilerPackageRoot(alias),canonical)
    assert.equal(isCompilerPackageImporter(canonical,join(canonical,'dist','parse.mjs')),true)
    assert.equal(isCompilerPackageImporter(canonical,canonical+'-other/dist/parse.mjs'),false)
    assert.equal(isCompilerPackageImporter(canonical,canonical),false)
    await assert.rejects(canonicalCompilerPackageRoot(join(scratch,'missing')),error=>error.code==='ENOENT')
  }finally{await rm(scratch,{recursive:true})}
})
