import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {supplementalRustNotice} from '../scripts/supplemental-rust-notices.mjs'

const identities=[
  ['napi-build','2.3.1','d376940fd5b723c6893cd1ee3f33abbfd86acb1cd1ec079f3ab04a2a3bc4d3b1','67e711d69b7e681807d157ea85cf8173fd923537','crates/build'],
  ['napi-derive-backend','5.0.3','1ca5a083f2c9b49a0c7d33ec75c083498849c6fcc46f5497317faa39ea77f5d5','78eb068d0a6a9664831c7f031318af11b990f1ac','crates/backend'],
  ['napi-derive','3.5.4','7430702d3cc05cf55f0a2c9e41d991c3b7a53f91e6146a8f282b1bfc7f3fd133','78eb068d0a6a9664831c7f031318af11b990f1ac','crates/macro'],
  ['napi-sys','3.2.1','8eb602b84d7c1edae45e50bbf1374696548f36ae179dfa667f577e384bb90c2b','be4b16ca00aa2cecd19be6ffe6de59495b471b14','crates/sys'],
  ['napi','3.8.5','fa73b028610e2b26e9e40bd2c8ff8a98e6d7ed5d67d89ebf4bfd2f992616b024','78eb068d0a6a9664831c7f031318af11b990f1ac','crates/napi'],
]

for(const [name,version,archiveSHA256,revision,pathInVCS] of identities)
test('supplemental Rust notice binds '+name+' to its locked archive and upstream revision',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rust-notice-identity-'))
  const vcs={git:{sha1:revision},path_in_vcs:pathInVCS}
  writeFileSync(join(directory,'.cargo_vcs_info.json'),JSON.stringify(vcs))
  const pkg={name,version,repository:'https://github.com/napi-rs/napi-rs',license:'MIT'}
  const notice=supplementalRustNotice(directory,pkg,archiveSHA256)
  assert.match(notice.text,/Copyright \(c\) 2020-present LongYinan/)
  assert.match(notice.text,/Copyright \(c\) 2018 GitHub/)
  assert.equal(notice.sha256,'3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215')
  assert.equal(notice.source,'https://raw.githubusercontent.com/napi-rs/napi-rs/'+revision+'/LICENSE')
  assert.equal(notice.archiveSHA256,archiveSHA256)
  assert.throws(()=>supplementalRustNotice(directory,pkg,'0'.repeat(64)),/archive identity changed/)
  assert.throws(()=>supplementalRustNotice(directory,{...pkg,repository:'https://example.com'},archiveSHA256),/repository changed/)
  assert.throws(()=>supplementalRustNotice(directory,{...pkg,license:'Apache-2.0'},archiveSHA256),/declared license changed/)
  writeFileSync(join(directory,'.cargo_vcs_info.json'),JSON.stringify({...vcs,git:{sha1:'0'.repeat(40)}}))
  assert.throws(()=>supplementalRustNotice(directory,pkg,archiveSHA256),/source revision changed/)
  writeFileSync(join(directory,'.cargo_vcs_info.json'),JSON.stringify({...vcs,path_in_vcs:'other'}))
  assert.throws(()=>supplementalRustNotice(directory,pkg,archiveSHA256),/source path changed/)
  writeFileSync(join(directory,'.cargo_vcs_info.json'),JSON.stringify(vcs))
  const project=mkdtempSync(join(tmpdir(),'rust-notice-changed-text-'))
  mkdirSync(join(project,'licenses/upstream'),{recursive:true})
  writeFileSync(join(project,notice.path),'Changed text')
  assert.throws(()=>supplementalRustNotice(directory,pkg,archiveSHA256,project),/notice text changed/)
  assert.equal(supplementalRustNotice(directory,{...pkg,version:'0.0.0'},archiveSHA256),undefined)
})
