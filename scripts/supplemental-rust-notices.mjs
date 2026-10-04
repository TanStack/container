import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const root=fileURLToPath(new URL('..',import.meta.url))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const repository='https://github.com/napi-rs/napi-rs'
const license={path:'licenses/upstream/napi-rs-wasm-runtime-1.2.4-LICENSE',
  sha256:'3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215'}
const records={
  'napi-build@2.3.1':{
    archiveSHA256:'d376940fd5b723c6893cd1ee3f33abbfd86acb1cd1ec079f3ab04a2a3bc4d3b1',
    revision:'67e711d69b7e681807d157ea85cf8173fd923537',pathInVCS:'crates/build',
  },
  'napi-derive-backend@5.0.3':{
    archiveSHA256:'1ca5a083f2c9b49a0c7d33ec75c083498849c6fcc46f5497317faa39ea77f5d5',
    revision:'78eb068d0a6a9664831c7f031318af11b990f1ac',pathInVCS:'crates/backend',
  },
  'napi-derive@3.5.4':{
    archiveSHA256:'7430702d3cc05cf55f0a2c9e41d991c3b7a53f91e6146a8f282b1bfc7f3fd133',
    revision:'78eb068d0a6a9664831c7f031318af11b990f1ac',pathInVCS:'crates/macro',
  },
  'napi-sys@3.2.1':{
    archiveSHA256:'8eb602b84d7c1edae45e50bbf1374696548f36ae179dfa667f577e384bb90c2b',
    revision:'be4b16ca00aa2cecd19be6ffe6de59495b471b14',pathInVCS:'crates/sys',
  },
  'napi@3.8.5':{
    archiveSHA256:'fa73b028610e2b26e9e40bd2c8ff8a98e6d7ed5d67d89ebf4bfd2f992616b024',
    revision:'78eb068d0a6a9664831c7f031318af11b990f1ac',pathInVCS:'crates/napi',
  },
}

// The caller verifies the complete crate archive and installed source first.
// These releases omit LICENSE, their exact VCS revisions contain the same
// upstream text already retained here. Never infer a notice from an SPDX tag.
export function supplementalRustNotice(directory,pkg,archiveSHA256,projectRoot=root){
  const record=records[pkg.name+'@'+pkg.version]
  if(!record)return undefined
  assert.equal(archiveSHA256,record.archiveSHA256,'Supplemental Rust archive identity changed: '+pkg.name)
  assert.equal(pkg.repository,repository,'Supplemental Rust repository changed: '+pkg.name)
  assert.equal(pkg.license,'MIT','Supplemental Rust declared license changed: '+pkg.name)
  const vcs=JSON.parse(readFileSync(join(directory,'.cargo_vcs_info.json'),'utf8'))
  assert.equal(vcs.git?.sha1,record.revision,'Supplemental Rust source revision changed: '+pkg.name)
  assert.equal(vcs.path_in_vcs,record.pathInVCS,'Supplemental Rust source path changed: '+pkg.name)
  const bytes=readFileSync(join(projectRoot,license.path))
  assert.equal(hash(bytes),license.sha256,'Supplemental Rust notice text changed')
  return {...license,...record,source:repository.replace('https://github.com/','https://raw.githubusercontent.com/')+'/'+record.revision+'/LICENSE',
    revisionEvidence:'Locked crate .cargo_vcs_info.json, checked against its registry archive',
    bytes:bytes.length,text:bytes.toString('utf8')}
}
