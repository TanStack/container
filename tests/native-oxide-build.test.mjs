import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {cargoRegistryChecksums,oxideBuildInputs,oxideWasmIdentity,verifyNativeOxideBuild,verifyOxideArchiveEntries,verifyOxideBindingInterface} from '../scripts/build-native-oxide.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')

test('native Oxide pins the source patch and isolated emnapi lock',()=>{
  const inputs=oxideBuildInputs()
  assert.equal(inputs.rustVersion,'1.95.0')
  assert.equal(inputs.target,'wasm32-wasip1-threads')
  assert.equal(inputs.emnapiVersion,'1.11.1')
  assert.match(inputs.sourceURL,new RegExp(inputs.revision+'$'))
  const lock=JSON.parse(readFileSync('tests/fixtures/native-oxide-build/package-lock.json'))
  assert.equal(lock.packages['node_modules/emnapi'].version,inputs.emnapiVersion)
  assert.deepEqual(Object.keys(lock.packages),['','node_modules/emnapi'])
})

test('the runtime exposes native scanning without a JavaScript workspace scanner',()=>{
  const source=readFileSync('src/native/browser-oxide.ts','utf8')
  assert.match(source,/binding=module\.default/)
  assert.doesNotMatch(source,/WorkspaceScanner|withWorkspaceSources|minimatch|readdirSync|lstatSync|scanFiles/)
})

test('source archives cannot escape the pinned prefix',()=>{
  assert.doesNotThrow(()=>verifyOxideArchiveEntries(['source/','source/crates/a.rs'],'source'))
  for(const name of ['/source/a','other/a','source/../a','source/./a','source\\a'])
    assert.throws(()=>verifyOxideArchiveEntries([name],'source'),/Unsafe/)
  assert.throws(()=>verifyOxideArchiveEntries([],'source'),/Empty/)
})

test('registry checksums come from locked package identities, not unpacked cache metadata',()=>{
  const checksum='a'.repeat(64)
  const fixture=`version = 4\n\n[[package]]\nname = "example"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\n\n[[package]]\nname = "workspace"\nversion = "0.1.0"\n`
  assert.deepEqual([...cargoRegistryChecksums(fixture)],[['example@1.2.3',checksum]])
  assert.throws(()=>cargoRegistryChecksums(fixture.replace(`checksum = "${checksum}"`,'')),/Missing locked/)
})

test('build records bind source identities, WASM and both Rust inventory files',()=>{
  const output=mkdtempSync(join(tmpdir(),'oxide-build-record-test-'))
  const inputs=oxideBuildInputs()
  const wasm=Buffer.from([0,97,115,109,1,0,0,0]),inventory=Buffer.from('{}\n'),notices=Buffer.from('notices\n')
  const record={format:1,inputs,compiler:{version:inputs.rustVersion,commit:inputs.rustCommit},
    wasm:oxideWasmIdentity(wasm),rustInputsSHA256:hash(inventory),rustNoticesSHA256:hash(notices)}
  writeFileSync(join(output,'tailwindcss-oxide.wasm32-wasi.wasm'),wasm)
  writeFileSync(join(output,'BUILD.json'),JSON.stringify(record))
  writeFileSync(join(output,'RUST-INPUTS.json'),inventory)
  writeFileSync(join(output,'RUST-NOTICES.txt'),notices)
  assert.deepEqual(verifyNativeOxideBuild(output),record)
  writeFileSync(join(output,'RUST-INPUTS.json'),'changed')
  assert.throws(()=>verifyNativeOxideBuild(output),/inventory changed/)
  writeFileSync(join(output,'RUST-INPUTS.json'),inventory)
  writeFileSync(join(output,'RUST-NOTICES.txt'),'changed')
  assert.throws(()=>verifyNativeOxideBuild(output),/notices changed/)
  writeFileSync(join(output,'RUST-NOTICES.txt'),notices)
  writeFileSync(join(output,'BUILD.json'),JSON.stringify({...record,inputs:{...inputs,revision:'wrong'}}))
  assert.throws(()=>verifyNativeOxideBuild(output),/source inputs/)
})

test('reordered WASM imports still instantiate through the same named JavaScript binding',()=>{
  const imported=name=>[4,104,111,115,116,3,...Buffer.from(name),0,0]
  const module=names=>Buffer.from([0,97,115,109,1,0,0,0,
    1,5,1,96,0,1,127,
    2,23,2,...names.flatMap(imported),
    3,2,1,0,
    7,10,1,6,...Buffer.from('answer'),0,2,
    10,6,1,4,0,16,names.indexOf('one'),11])
  const first=module(['one','two']),second=module(['two','one'])
  const actual=oxideWasmIdentity(first),expected=oxideWasmIdentity(second)
  assert.notDeepEqual(actual.imports,expected.imports)
  const before=structuredClone(actual)
  verifyOxideBindingInterface(actual,expected)
  assert.deepEqual(actual,before,'Compatibility checking must not rewrite the original identity')
  const imports={host:{one:()=>1,two:()=>2}}
  for(const bytes of [first,second])
    assert.equal(new WebAssembly.Instance(new WebAssembly.Module(bytes),imports).exports.answer(),1)
})

test('binding interface checks preserve names, kinds, missing/extra entries and duplicate counts',()=>{
  const expected={imports:[{module:'env',name:'memory',kind:'memory'},{module:'wasi',name:'random_get',kind:'function'}],
    exports:[{name:'scan',kind:'function'},{name:'table',kind:'table'}]}
  verifyOxideBindingInterface({imports:expected.imports.toReversed(),exports:expected.exports.toReversed()},expected)
  for(const imports of [expected.imports.slice(1),[...expected.imports,expected.imports[0]],
    expected.imports.map((entry,index)=>index===0?{...entry,module:'other'}:entry),
    expected.imports.map((entry,index)=>index===0?{...entry,name:'other'}:entry),
    expected.imports.map((entry,index)=>index===0?{...entry,kind:'function'}:entry)])
    assert.throws(()=>verifyOxideBindingInterface({...expected,imports},expected),/imports differ/)
  for(const exports of [expected.exports.slice(1),[...expected.exports,expected.exports[0]],
    expected.exports.map((entry,index)=>index===0?{...entry,name:'other'}:entry),
    expected.exports.map((entry,index)=>index===0?{...entry,kind:'memory'}:entry)])
    assert.throws(()=>verifyOxideBindingInterface({...expected,exports},expected),/exports differ/)
})
