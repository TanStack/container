import test from 'node:test'
import assert from 'node:assert/strict'
import {memfs} from 'memfs'
import {readFileSync} from 'node:fs'
import {writeFileWithParents} from '../src/native/write-file-with-parents.mjs'

test('every CI release-test gate installs the older locked codec fixture first',()=>{
  for(const file of ['native-checks.yml','source-checks.yml','release.yml']){
    const source=readFileSync(new URL('../.github/workflows/'+file,import.meta.url),'utf8')
    const setup='npm ci --prefix tests/fixtures/wasi-filesystem-codec-114 --ignore-scripts'
    let previous=-1,count=0
    for(const gate of source.matchAll(/(?:npm run|pnpm) test:release/g)){
      assert.ok(source.lastIndexOf(setup,gate.index)>previous,file+' must install its codec before this gate')
      previous=gate.index;count++
    }
    assert.equal(count,file==='release.yml'?2:1)
  }
})

test('checked writes keep path checks, parent creation and file modes in their original order',()=>{
  const {fs}=memfs(),calls=[]
  const counted=Object.fromEntries(['lstatSync','mkdirSync','writeFileSync'].map(name=>[name,(...args)=>{
    calls.push({name,path:args[0]});return Reflect.apply(fs[name],fs,args)
  }]))
  writeFileWithParents(counted,'/app/nested/file',new Uint8Array([0,255]),{followSymlinks:false,mode:0o755})
  assert.deepEqual(calls,[{name:'lstatSync',path:'/app'},{name:'lstatSync',path:'/app/nested'},
    {name:'lstatSync',path:'/app/nested/file'},{name:'mkdirSync',path:'/app/nested'},
    {name:'writeFileSync',path:'/app/nested/file'}])
  assert.deepEqual([...fs.readFileSync('/app/nested/file')],[0,255])
  assert.equal(fs.statSync('/app/nested/file').mode&0o777,0o755)
  assert.throws(()=>writeFileWithParents(counted,'/',new Uint8Array()),/workspace root/)
})

test('local file operation failures retain identity and stop later work',()=>{
  for(const failing of ['lstatSync','mkdirSync','writeFileSync']){
    const failure=Object.assign(Error('ordinary file failure'),{code:'EIO'}),calls=[]
    const fs=Object.fromEntries(['lstatSync','mkdirSync','writeFileSync'].map(name=>[name,()=>{
      calls.push(name);if(name===failing)throw failure
      return {isSymbolicLink:()=>false}
    }]))
    assert.throws(()=>writeFileWithParents(fs,'/file',new Uint8Array(),{followSymlinks:false}),error=>error===failure)
    assert.deepEqual(calls,['lstatSync','mkdirSync','writeFileSync'].slice(0,['lstatSync','mkdirSync','writeFileSync'].indexOf(failing)+1))
  }
})

test('ordinary link behavior remains selectable and each write checks the current namespace',()=>{
  const {fs}=memfs({'/app/target/file':'before'})
  fs.symlinkSync('/app/target','/app/link')
  assert.throws(()=>writeFileWithParents(fs,'/app/link/file',new Uint8Array([1]),{followSymlinks:false}),/symbolic link/)
  assert.equal(fs.readFileSync('/app/target/file','utf8'),'before')
  writeFileWithParents(fs,'/app/link/file',new Uint8Array([2]))
  assert.deepEqual([...fs.readFileSync('/app/target/file')],[2])
  fs.unlinkSync('/app/link');fs.mkdirSync('/app/link')
  writeFileWithParents(fs,'/app/link/file',new Uint8Array([3]),{followSymlinks:false})
  assert.deepEqual([...fs.readFileSync('/app/link/file')],[3])
})
