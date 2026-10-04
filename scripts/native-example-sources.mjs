import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'

export const nativeReleaseExamples=[
  {kind:'react',path:'start-counter',fixture:'native-real-counter'},
  {kind:'react',path:'start-basic',fixture:'native-real-start-basic'},
  {kind:'react',path:'start-streaming-data-from-server-functions',fixture:'native-real-start-streaming'},
  {kind:'react',path:'basic-ssr-file-based',fixture:'native-real-router-ssr'},
  {kind:'solid',path:'start-counter',fixture:'native-real-solid-counter'},
]
export const nativeExampleHash=bytes=>createHash('sha256').update(bytes).digest('hex')
const safePath=value=>typeof value==='string'&&value.split('/').every(part=>part!=='.'&&part!=='..'&&/^[A-Za-z0-9@._$+\[\]-]+$/.test(part))

export function readPinnedNativeExamples(root=process.cwd(),directory=join(root,'tests/fixtures/native-owner-sources')){
  root=resolve(root)
  const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'))
  assert.equal(manifest.format,1,'Unsupported native example source format')
  assert.equal(manifest.repository,'https://github.com/TanStack/router.git')
  assert.match(manifest.revision,/^[0-9a-f]{40}$/,'Native examples require a pinned source revision')
  assert.equal(nativeExampleHash(readFileSync(join(directory,'LICENSE'))),manifest.licenseSHA256,'Native example license changed')
  assert.ok(Array.isArray(manifest.examples),'Native example list missing')
  assert.deepEqual(manifest.examples.map(({kind,path,fixture})=>({kind,path,fixture})),nativeReleaseExamples,
    'Native release requires all five pinned examples in order')
  const result=new Map()
  for(const entry of manifest.examples){
    assert.ok(safePath(entry.snapshot),'Unsafe native example snapshot path')
    assert.ok(/^[0-9a-f]{64}$/.test(entry.sha256),'Invalid native example snapshot hash')
    const bytes=readFileSync(join(directory,entry.snapshot))
    assert.equal(nativeExampleHash(bytes),entry.sha256,'Native example snapshot changed: '+entry.path)
    const snapshot=JSON.parse(bytes.toString('utf8'))
    assert.ok(Array.isArray(snapshot.files)&&snapshot.files.length>0,'Native example source is empty')
    const files={}
    for(const file of snapshot.files){
      assert.ok(safePath(file.path),'Unsafe native example source path')
      assert.ok(!Object.hasOwn(files,'/project/'+file.path),'Duplicate native example source file')
      assert.ok(typeof file.base64==='string'&&Number.isSafeInteger(file.bytes)&&file.bytes>=0&&file.bytes<=4*1024*1024,
        'Invalid native example source bytes')
      const contents=Buffer.from(file.base64,'base64')
      assert.equal(contents.toString('base64'),file.base64,'Noncanonical native example base64')
      assert.equal(contents.length,file.bytes,'Native example source length mismatch')
      assert.equal(nativeExampleHash(contents),file.sha256,'Native example source hash mismatch')
      files['/project/'+file.path]=new Uint8Array(contents)
    }
    assert.ok(files['/project/package.json'],'Native example package manifest missing')
    const lock=readFileSync(join(root,'fixtures',entry.fixture,'package-lock.json'))
    assert.equal(nativeExampleHash(lock),entry.npmLockSHA256,'Native example lockfile changed: '+entry.path)
    const original=JSON.parse(new TextDecoder().decode(files['/project/package.json']))
    const locked=JSON.parse(lock.toString('utf8')).packages['']
    for(const field of ['dependencies','devDependencies','optionalDependencies'])
      assert.deepEqual(locked[field]??{},original[field]??{},'Native example lock root differs from original manifest: '+field)
    files['/project/package-lock.json']=lock.toString('utf8')
    result.set(entry.kind+'/'+entry.path,{files,revision:manifest.revision,sourceSHA256:entry.sha256,npmLockSHA256:entry.npmLockSHA256})
  }
  return {manifest,examples:result,manifestSHA256:nativeExampleHash(readFileSync(join(directory,'manifest.json')))}
}
