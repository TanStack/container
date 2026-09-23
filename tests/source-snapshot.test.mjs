import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {gzipSync,gunzipSync} from 'node:zlib'
import {createSourceSnapshot,listSourceSnapshotFiles,verifySourceSnapshot} from '../scripts/source-snapshot.mjs'

function fixture(){
  const parent=mkdtempSync(join(tmpdir(),'source-snapshot-')),root=join(parent,'workspace')
  mkdirSync(join(root,'src'),{recursive:true});mkdirSync(join(root,'node_modules/pkg'),{recursive:true});mkdirSync(join(root,'test-results'),{recursive:true});mkdirSync(join(root,'dist'),{recursive:true});mkdirSync(join(root,'fixtures/example/.npm-cache/_cacache'),{recursive:true})
  mkdirSync(join(root,'fixtures/workloads/generated/case'),{recursive:true})
  mkdirSync(join(root,'fixtures/workloads/projects/sveltekit'),{recursive:true})
  writeFileSync(join(root,'src/index.js'),'export const answer = 42\n')
  writeFileSync(join(root,'package.json'),'{"name":"fixture"}\n')
  writeFileSync(join(root,'.env'),'TOKEN=private\n')
  writeFileSync(join(root,'.env.example'),'TOKEN=\n')
  writeFileSync(join(root,'private.pem'),'private\n')
  writeFileSync(join(root,'node_modules/pkg/index.js'),'dependency\n')
  writeFileSync(join(root,'test-results/result.json'),'result\n')
  writeFileSync(join(root,'dist/output.js'),'generated\n')
  writeFileSync(join(root,'fixtures/example/.npm-cache/_cacache/blob'),'generated package cache\n')
  writeFileSync(join(root,'fixtures/workloads/generated/case/output.js'),'generated fixture\n')
  writeFileSync(join(root,'fixtures/workloads/projects/sveltekit/reference-bootstrap.mjs'),'import "/developer/workspace/module.js"\n')
  return {parent,root}
}

test('creates a reproducible content-addressed source archive',()=>{
  const value=fixture(),first=join(value.parent,'first.tar.gz'),second=join(value.parent,'second.tar.gz')
  const one=createSourceSnapshot(value.root,first),two=createSourceSnapshot(value.root,second)
  assert.equal(one.revision,two.revision);assert.deepEqual(readFileSync(first),readFileSync(second))
  assert.equal(one.revision,'sha256:'+createHash('sha256').update(readFileSync(first)).digest('hex'))
  assert.equal(verifySourceSnapshot(value.root,first).revision,one.revision)
  const listed=spawnSync('tar',['-tzf',first],{encoding:'utf8'})
  assert.equal(listed.status,0);assert.deepEqual(listed.stdout.trim().split('\n'),[
    'web-container-source/.env.example','web-container-source/package.json','web-container-source/src/index.js',
  ])
})

test('rejects a source archive after the source changes',()=>{
  const value=fixture(),archive=join(value.parent,'source.tar.gz')
  createSourceSnapshot(value.root,archive)
  writeFileSync(join(value.root,'src/index.js'),'changed\n')
  assert.throws(()=>verifySourceSnapshot(value.root,archive),/does not match the current source tree/)
})

test('accepts identical canonical tar bytes with different compression and retains actual archive identity',()=>{
  const {root,parent}=fixture(),original=join(parent,'original.tar.gz'),recompressed=join(parent,'recompressed.tar.gz')
  const created=createSourceSnapshot(root,original)
  const tar=gunzipSync(readFileSync(original)),bytes=gzipSync(tar,{level:0})
  writeFileSync(recompressed,bytes)
  assert.notDeepEqual(bytes,readFileSync(original))
  const verified=verifySourceSnapshot(root,recompressed)
  assert.equal(verified.sha256,createHash('sha256').update(bytes).digest('hex'))
  assert.equal(verified.revision,'sha256:'+verified.sha256)
  assert.notEqual(verified.revision,created.revision)
  assert.equal(verified.tarSHA256,created.tarSHA256)
})

test('rejects altered tar metadata, appended payloads and invalid compressed input',()=>{
  const {root,parent}=fixture(),archive=join(parent,'original.tar.gz'),changed=join(parent,'changed.tar.gz')
  createSourceSnapshot(root,archive)
  const tar=gunzipSync(readFileSync(archive)),metadata=Buffer.from(tar)
  metadata[136]=0x31
  for(const bytes of [gzipSync(metadata),gzipSync(Buffer.concat([tar,Buffer.alloc(2048)])),Buffer.from('not gzip')]){
    writeFileSync(changed,bytes)
    assert.throws(()=>verifySourceSnapshot(root,changed),/does not match the current source tree/)
  }
})

test('excludes dependencies, generated output, results and sensitive files',()=>{
  const {root}=fixture(),paths=listSourceSnapshotFiles(root).map(file=>file.path)
  assert.deepEqual(paths,['.env.example','package.json','src/index.js'])
})

test('refuses to write the archive into the source tree',()=>{
  const {root}=fixture()
  assert.throws(()=>createSourceSnapshot(root,join(root,'source.tar.gz')),/outside the source tree/)
})
