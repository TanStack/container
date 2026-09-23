import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {collectInstalledClosure} from '../scripts/collect-installed-closure.mjs'

test('installed closure preserves dependency nesting, dynamic assets and optional absence',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'installed-closure-'))
  try{
    const put=async(name,contents)=>{
      const file=path.join(root,name)
      await mkdir(path.dirname(file),{recursive:true})
      await writeFile(file,contents)
    }
    await put('node_modules/app/package.json',JSON.stringify({name:'app',version:'1',dependencies:{shared:'2',other:'1'},optionalDependencies:{absent:'1'}}))
    await put('node_modules/app/dynamic/data.bin',Buffer.from([0,255,128]))
    await put('node_modules/app/node_modules/shared/package.json',JSON.stringify({name:'shared',version:'2'}))
    await put('node_modules/shared/package.json',JSON.stringify({name:'shared',version:'1'}))
    await put('node_modules/other/package.json',JSON.stringify({name:'other',version:'1',dependencies:{shared:'1'}}))
    await put('node_modules/unrelated/package.json',JSON.stringify({name:'unrelated'}))
    const first=await collectInstalledClosure(root,['app'])
    assert.deepEqual(await collectInstalledClosure(root,['app']),first)
    assert.deepEqual(Buffer.from(first.files['/node_modules/app/dynamic/data.bin'].base64,'base64'),Buffer.from([0,255,128]))
    assert.equal(first.preparation.packages.length,4)
    assert.ok(first.files['/node_modules/app/node_modules/shared/package.json'])
    assert.ok(first.files['/node_modules/shared/package.json'])
    assert.equal(first.files['/node_modules/unrelated/package.json'],undefined)
    assert.deepEqual(first.preparation.missingOptional,[{name:'absent',from:'/node_modules/app'}])
    await assert.rejects(collectInstalledClosure(root,['missing']),/Missing installed dependency/)
  }finally{await rm(root,{recursive:true,force:true})}
})
