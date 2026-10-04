import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readPackageNotices,readmeMITNotice,addPackageNotices} from '../scripts/package-notices.mjs'

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
test('collects the full MIT notice shipped in a README, with original attribution',()=>{
  const readme=readFileSync('node_modules/brorand/README.md','utf8')
  const expected=readme.slice(readme.indexOf('#### LICENSE')+'#### LICENSE'.length).trim()
  const directory=fixture()
  writeFileSync(join(directory,'README.md'),readme)
  assert.equal(readPackageNotices(directory),expected)
  assert.ok(expected.includes('Copyright Fedor Indutny, 2014.'))
  assert.ok(!expected.includes('#### LICENSE'))
  assert.equal(readmeMITNotice(readme+'\n## Usage\nNot part of the notice\n'),expected)
})
test('bundled browser dependencies retain their README license text',()=>{
  for(const name of ['asn1.js','brorand','des.js','elliptic','hash.js','hmac-drbg',
    'isarray','miller-rabin','minimalistic-crypto-utils']){
    const notice=readPackageNotices('node_modules/'+name)
    assert.match(notice,/^Copyright[^\r\n]+/im,name)
    assert.match(notice,/Permission is hereby granted/,name)
    assert.match(notice,/OTHER DEALINGS IN THE\s+SOFTWARE\./i,name)
  }
})
test('README identifiers, links and incomplete MIT notices do not count as license text',()=>{
  assert.equal(readmeMITNotice('## License\nMIT\n'),'')
  assert.equal(readmeMITNotice('## License\n[MIT](LICENSE)\n'),'')
  const full=readFileSync('node_modules/brorand/README.md','utf8')
  for(const fragment of ['Copyright Fedor Indutny, 2014.',
    'The above copyright notice and this permission notice shall be included',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT']){
    assert.equal(readmeMITNotice(full.replace(fragment,'')),'')
  }
  assert.equal(readmeMITNotice(full.replace('#### LICENSE','#### Usage')),'')
})
