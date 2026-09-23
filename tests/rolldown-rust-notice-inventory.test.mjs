import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildRolldownRustNoticeInventory,packageNotices,reachablePackages} from '../scripts/rolldown-rust-notice-inventory.mjs'

test('walks normal and build Cargo edges but excludes dev-only edges',()=>{
  const pkg=(id,name)=>({id,name,version:'1.0.0'})
  const metadata={packages:[pkg('root','rolldown_binding'),pkg('normal','normal'),pkg('build','build'),pkg('dev','dev')],resolve:{nodes:[
    {id:'root',deps:[{pkg:'normal',dep_kinds:[{kind:null}]},{pkg:'build',dep_kinds:[{kind:'build'}]},{pkg:'dev',dep_kinds:[{kind:'dev'}]}]},
    {id:'normal',deps:[]},{id:'build',deps:[]},{id:'dev',deps:[]},
  ]}}
  assert.deepEqual(reachablePackages(metadata).map(pkg=>pkg.name).sort(),['build','normal','rolldown_binding'])
})

test('records package notices and falls back to the pinned repository notice for workspace crates',()=>{
  const root=mkdtempSync(join(tmpdir(),'rolldown-notices-test-')),workspace=join(root,'crates/local'),registry=join(root,'registry/package')
  mkdirSync(workspace,{recursive:true});mkdirSync(registry,{recursive:true})
  writeFileSync(join(root,'LICENSE'),'root license');writeFileSync(join(workspace,'Cargo.toml'),'');writeFileSync(join(registry,'Cargo.toml'),'');writeFileSync(join(registry,'LICENSE-MIT'),'package license')
  const local=packageNotices({manifest_path:join(workspace,'Cargo.toml'),source:null},root,join(root,'LICENSE'))
  const external=packageNotices({manifest_path:join(registry,'Cargo.toml'),source:'registry'},root,join(root,'LICENSE'))
  assert.equal(local.workspace,true);assert.deepEqual(local.notices.map(notice=>notice.path),['LICENSE'])
  assert.equal(external.workspace,false);assert.deepEqual(external.notices.map(notice=>notice.path),['LICENSE-MIT'])
})

test('requires verified pinned source identity before stamping an inventory revision',()=>{
  const root=mkdtempSync(join(tmpdir(),'rolldown-identity-test-'))
  writeFileSync(join(root,'LICENSE'),'root license')
  const metadata={packages:[{id:'root',name:'rolldown_binding',version:'1.0.0',manifest_path:join(root,'Cargo.toml'),source:null}],resolve:{nodes:[{id:'root',deps:[]}]}}
  writeFileSync(join(root,'Cargo.toml'),'')
  assert.throws(()=>buildRolldownRustNoticeInventory(metadata,root),/verified pinned Rolldown source identity/)
})
