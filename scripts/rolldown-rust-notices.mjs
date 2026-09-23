import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {basename,join} from 'node:path'
import {copyFileSync,readFileSync,writeFileSync} from 'node:fs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const inventoryRecord={path:'licenses/rolldown-rust-notice-inventory.json',sha256:'b912a6e2b227bd40715e01f88529dce2acbb4e57ca616a89bf5f7e2c384f864d'}
const unresolvedRecord={path:'licenses/rolldown-rust-unresolved-notices.json',sha256:'0b63943da495bd496e995b97b9d9444241533e371c9e865306bc78397a54e459'}
const packageNoticeRecord={path:'licenses/rolldown-rust-package-notices.txt',sha256:'13507ab1eb9217fb77d7c735f5629618adcf7189a78769bd6e25d50c7d2a7745'}
const groups=[
  {repository:'https://github.com/oxc-project/oxc',revision:'5a6e37e5cf895143a5b34050c50109c46e2ae96a',count:27,file:'oxc-5a6e37e5-LICENSE',sha256:'95ced5ecf1133fbf41d409b5555c86c344f83f3b019926057ddbc07cfdcc27b3'},
  {repository:'https://github.com/napi-rs/napi-rs',revision:'43100baf28a3e5709641e35f892be4da5d62dcb2',count:2,file:'napi-rs-43100baf-LICENSE',sha256:'3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215'},
  {repository:'https://github.com/napi-rs/napi-rs',revision:'31c27a1676a7c4b317f4e144e0a9cb94e8354143',count:3,file:'napi-rs-31c27a16-LICENSE',sha256:'3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215'},
  {repository:'https://github.com/Nugine/simd',revision:'d74c030d9dc4f3cae02146d1f497ff62726ef09a',count:2,file:'nugine-simd-d74c030d-LICENSE',sha256:'71674605ec4c087fe9eb534e3e4f9e26eb2e4aabcd76a29fd156c6a844d44b3d'},
  {repository:'https://github.com/oxc-project/oxc-resolver',revision:'b6a6125c5556ca1ae0e48b479d203e8f06effd10',count:2,file:'oxc-resolver-b6a6125c-LICENSE',sha256:'95ced5ecf1133fbf41d409b5555c86c344f83f3b019926057ddbc07cfdcc27b3'},
  {repository:'https://github.com/oxc-project/oxc-index-vec',revision:'8e09fe324eb6df02f56e4eacdfac958930300380',count:1,file:'oxc-index-vec-8e09fe32-LICENSE',sha256:'95ced5ecf1133fbf41d409b5555c86c344f83f3b019926057ddbc07cfdcc27b3'},
  {repository:'https://github.com/oxc-project/oxc-browserslist',revision:'a9b49a18042671c91811dc1074e01b9c08331327',count:1,file:'oxc-browserslist-a9b49a18-LICENSE',sha256:'6fb8065469e053e7193bd6a82616740b2819725fbd12a027aa99534643247cca'},
  {repository:'https://github.com/oxc-project/fast-glob.git',revision:'3b6c31c39a676257fd1d95c338025b64f3f0395a',count:1,file:'oxc-fast-glob-3b6c31c3-LICENSE',sha256:'7fb47d7306f9a3ba25b44e7b9a94a300548a46709ed27753e28deac8e868b1cd'},
  {repository:'https://github.com/oxc-project/nodejs-built-in-modules',revision:'9117efa38fe088325e8a1036a8ddea7f3546c1ac',count:1,file:'oxc-nodejs-built-in-modules-9117efa3-LICENSE',sha256:'20538257cfb1812d48164a7d11c0008a66b33c01b4debdfa0ec2a104fe00f028'},
  {repository:'https://github.com/Aleph-Alpha/ts-rs',revision:'7182ad8289596097235406b715fa04506443b4ad',count:2,file:'ts-rs-7182ad82-LICENSE',sha256:'db7f7f8e7236a2d0b41b855b2501b7b913caebbcda6ce498637a304ad1706ce1'},
  {repository:'https://github.com/Canop/lazy-regex/tree/main/src/proc_macros',revision:'39a459c01e1ba2488075be50a821e2d72e466241',count:1,file:'lazy-regex-39a459c0-LICENSE',sha256:'89461664ce2aee7d80ea8fba7118fe7abd490d76ba435cf1d81d3128e060711f'},
]

function checkedJSON(record){
  const bytes=readFileSync(new URL('../'+record.path,import.meta.url))
  assert.equal(hash(bytes),record.sha256,`Rolldown Rust evidence changed: ${record.path}`)
  return {bytes,json:JSON.parse(bytes)}
}

export function writeRolldownRustNotices(directory){
  const inventory=checkedJSON(inventoryRecord),unresolved=checkedJSON(unresolvedRecord)
  const packageNoticeBytes=readFileSync(new URL('../'+packageNoticeRecord.path,import.meta.url))
  assert.equal(hash(packageNoticeBytes),packageNoticeRecord.sha256,'Rolldown Rust package notice text bundle changed')
  assert.equal(inventory.json.source.revision,'5b4746e442989d770c606ce08d2737e6aafbd25d','Unexpected Rolldown source revision')
  assert.equal(inventory.json.summary.missingNotice,47,'Rolldown missing-notice inventory changed')
  const missing=inventory.json.packages.filter(pkg=>pkg.notices.length===0),covered=[],noticePaths=[]
  for(const group of groups){
    const packages=missing.filter(pkg=>pkg.repository===group.repository&&pkg.vcs?.sha1===group.revision)
    assert.equal(packages.length,group.count,`Rolldown notice family changed: ${group.repository}@${group.revision}`)
    const source=new URL('../licenses/upstream/'+group.file,import.meta.url),bytes=readFileSync(source)
    assert.equal(hash(bytes),group.sha256,`Rolldown supplemental license changed: ${group.file}`)
    copyFileSync(source,join(directory,group.file))
    noticePaths.push('licenses/'+group.file)
    covered.push(...packages.map(pkg=>pkg.name+'@'+pkg.version))
  }
  const unresolvedNames=unresolved.json.unresolved.flatMap(record=>record.crates).sort()
  const coveredSet=new Set(covered),remaining=missing.map(pkg=>pkg.name+'@'+pkg.version).filter(name=>!coveredSet.has(name)).sort()
  assert.deepEqual(remaining,unresolvedNames,'Rolldown unresolved notice records changed')
  const inventoryName='ROLLDOWN-RUST-NOTICE-INVENTORY.json',unresolvedName='ROLLDOWN-RUST-UNRESOLVED-NOTICES.json'
  writeFileSync(join(directory,inventoryName),inventory.bytes)
  writeFileSync(join(directory,unresolvedName),unresolved.bytes)
  const packageNoticeName='ROLLDOWN-RUST-PACKAGE-NOTICES.txt'
  writeFileSync(join(directory,packageNoticeName),packageNoticeBytes)
  const evidence={format:1,complete:false,scope:'Overinclusive Cargo metadata review, not exact linked-code evidence or legal clearance',source:inventory.json.source,packages:inventory.json.summary,coveredMissingNoticeRecords:covered.sort(),unresolvedMissingNoticeRecords:remaining,exactLinkedContents:false,packageNoticeTexts:{path:'licenses/'+packageNoticeName,sha256:packageNoticeRecord.sha256,uniqueTexts:134,attributions:391},notices:groups.map(group=>({repository:group.repository,revision:group.revision,path:'licenses/'+group.file,sha256:group.sha256})),inventory:{path:'licenses/'+inventoryName,sha256:inventoryRecord.sha256},unresolved:{path:'licenses/'+unresolvedName,sha256:unresolvedRecord.sha256}}
  const evidenceName='ROLLDOWN-RUST-NOTICE-EVIDENCE.json',text=JSON.stringify(evidence,null,2)+'\n'
  writeFileSync(join(directory,evidenceName),text)
  return {complete:false,evidence,path:'licenses/'+evidenceName,sha256:hash(text),notices:[...noticePaths,'licenses/'+packageNoticeName,'licenses/'+inventoryName,'licenses/'+unresolvedName,'licenses/'+evidenceName]}
}
