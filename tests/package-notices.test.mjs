import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readPackageNotices,addPackageNotices} from '../scripts/package-notices.mjs'

function fixture(){return mkdtempSync(join(tmpdir(),'package-notices-test-'))}
test('collects license and NOTICE variants without unrelated files',()=>{
  const directory=fixture()
  const names=['LICENSE','LICENCE.md','COPYING.txt','NOTICE','notice.txt','LICENSE-MIT']
  for(const name of [...names,'README.md','notices-helper.js','licensee.js'])writeFileSync(join(directory,name),'text:'+name)
  assert.equal(readPackageNotices(directory),names.sort((a,b)=>a.localeCompare(b)).map(name=>'text:'+name).join('\n'))
})
test('keeps two versions of a package and deduplicates repeated input identity',()=>{
  const one=fixture(),two=fixture(),packages=new Map()
  writeFileSync(join(one,'LICENSE'),'version one license')
  writeFileSync(join(one,'NOTICE'),'version one attribution')
  writeFileSync(join(two,'LICENSE'),'version two license')
  writeFileSync(join(two,'NOTICE.txt'),'version two attribution')
  addPackageNotices(packages,one,{name:'same-package',version:'1.0.0',license:'MIT'})
  addPackageNotices(packages,two,{name:'same-package',version:'2.0.0',license:'MIT'})
  addPackageNotices(packages,one,{name:'same-package',version:'1.0.0',license:'MIT'})
  assert.equal(packages.size,2)
  assert.equal(packages.get('same-package@1.0.0').notices,'version one license\nversion one attribution')
  assert.equal(packages.get('same-package@2.0.0').notices,'version two license\nversion two attribution')
})
test('rejects a non-file notice rather than silently losing attribution',()=>{
  const directory=fixture();mkdirSync(join(directory,'NOTICE'))
  assert.throws(()=>readPackageNotices(directory),/Expected a regular package notice file/)
})
test('rejects missing identity and retains an empty notice result for explicit review',()=>{
  const directory=fixture()
  assert.throws(()=>addPackageNotices(new Map(),directory,{name:'example'}),/Missing package notice identity/)
  assert.equal(readPackageNotices(directory),'')
})
