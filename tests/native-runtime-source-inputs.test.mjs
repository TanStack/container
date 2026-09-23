import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {readNativeSourceDescriptor,verifyNativeSourceRoot} from '../scripts/verified-native-source.mjs'

const projectRoot=resolve('.')
const hash=value=>createHash('sha256').update(value).digest('hex')
function digest(entries){
  const value=createHash('sha256')
  for(const [name,fileHash] of entries.sort(([left],[right])=>left<right?-1:left>right?1:0))value.update(name).update('\0').update(fileHash).update('\n')
  return value.digest('hex')
}

for(const spec of [
  {id:'http2',descriptor:'build-inputs/http2-source.json',license:'COPYING'},
  {id:'tls',descriptor:'build-inputs/tls-source.json',license:'LICENSE'},
])test(`${spec.id} committed source descriptor matches the shipped build evidence`,()=>{
  const descriptor=readNativeSourceDescriptor(join(projectRoot,spec.descriptor))
  const build=JSON.parse(readFileSync(join(projectRoot,`public/${spec.id}-runtime/build.json`),'utf8'))
  assert.equal(descriptor.version,build.source.version)
  assert.equal(descriptor.archive.url,build.source.url)
  assert.equal(descriptor.archive.sha256,build.source.sha256)
  assert.equal(descriptor.license.sha256,build.source.licenseSHA256)
  const prefix=build.source.directory?build.source.directory.replaceAll('\\','/')+'/':'$SOURCE_ROOT/'
  const entries=Object.entries(build.hashes)
    .map(([path,fileHash])=>[path.replaceAll('\\','/'),fileHash])
    .filter(([path])=>path.startsWith(prefix))
    .map(([path,fileHash])=>[path.slice(prefix.length),fileHash])
  entries.push([spec.license,build.source.licenseSHA256])
  assert.equal(entries.length,descriptor.inputs.fileCount)
  assert.equal(digest(entries),descriptor.inputs.sha256)
})

test('native source verification accepts exact inputs and rejects changed build inputs',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'native-source-input-test-'))
  try{
    const root=join(temporary,'source'),descriptorPath=join(temporary,'source.json')
    mkdirSync(join(root,'src'),{recursive:true})
    mkdirSync(join(root,'include','nested'),{recursive:true})
    const fixture=[['LICENSE','license\n'],['src/a.c','int a;\n'],['include/nested/a.h','#define A 1\n']]
    for(const [name,contents] of fixture)writeFileSync(join(root,name),contents)
    const entries=fixture.map(([name,contents])=>[name,hash(contents)])
    writeFileSync(descriptorPath,JSON.stringify({
      format:1,id:'fixture',version:'1.0.0',
      archive:{url:'https://example.test/fixture.tar.gz',sha256:'a'.repeat(64)},
      license:{path:'LICENSE',sha256:hash('license\n')},
      inputs:{sourceDirectory:'src',sourceExtension:'.c',headerDirectory:'include',headerExtension:'.h',fileCount:entries.length,sha256:digest(entries)},
    }))
    const result=verifyNativeSourceRoot(descriptorPath,root)
    const realRoot=realpathSync(root)
    assert.deepEqual(result.sources,[join(realRoot,'src/a.c')])
    assert.deepEqual(result.headers,[join(realRoot,'include/nested/a.h')])
    writeFileSync(join(root,'include/nested/a.h'),'#define A 2\n')
    assert.throws(()=>verifyNativeSourceRoot(descriptorPath,root),/input hash mismatch/)
    writeFileSync(join(root,'include/nested/extra.h'),'#define EXTRA 1\n')
    assert.throws(()=>verifyNativeSourceRoot(descriptorPath,root),/input count mismatch/)
  }finally{rmSync(temporary,{recursive:true,force:true})}
})

test('native runtime builders have no report or machine-specific source dependency',()=>{
  for(const name of ['build-http2-runtime.mjs','build-tls-runtime.mjs']){
    const script=readFileSync(join(projectRoot,'scripts',name),'utf8')
    assert.doesNotMatch(script,/reports\/(?:http2|tls)-source\.json/)
    assert.doesNotMatch(script,/\/private\/tmp/)
    assert.match(script,/SOURCE_ROOT/)
    assert.match(script,/EMCC/)
    assert.match(script,/RUNTIME_OUTPUT/)
    assert.match(script,/\$OUTPUT_ROOT/)
    assert.match(script,/-ffile-prefix-map=/)
    assert.match(script,/-fmacro-prefix-map=/)
  }
})
