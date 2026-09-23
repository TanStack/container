import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {createCopyAPI} from '../src/sandbox/guest-fs-cp.js'
const copy=createCopyAPI(fs,path,value=>String(value))
function fixture(){const root=fs.mkdtempSync(path.join(tmpdir(),'guest-copy-'));fs.mkdirSync(path.join(root,'source'));fs.mkdirSync(path.join(root,'source/sub'));fs.writeFileSync(path.join(root,'source/a'),'a');fs.writeFileSync(path.join(root,'source/sub/b'),'b');return root}
function tree(root){return fs.readdirSync(root,{recursive:true}).sort().map(name=>{const file=path.join(root,name),stat=fs.lstatSync(file);return [name,stat.isSymbolicLink()?'link:'+fs.readlinkSync(file):stat.isDirectory()?'dir':fs.readFileSync(file,'utf8')]})}
test('recursive copy and async filter match native Node',async()=>{
  const root=fixture(),source=path.join(root,'source')
  for(const recursive of [false,true]){
    const opts={recursive,filter:async source=>!source.endsWith('/b')}
    if(!recursive){await assert.rejects(copy.cp(source,path.join(root,'a'),opts),{code:'ERR_FS_EISDIR'});continue}
    await copy.cp(source,path.join(root,'actual'),opts);await fs.promises.cp(source,path.join(root,'expected'),opts)
    assert.deepEqual(tree(path.join(root,'actual')),tree(path.join(root,'expected')))
  }
})
test('sync file overwrite force and errorOnExist match Node',()=>{
  const root=fixture(),source=path.join(root,'source/a')
  for(const options of [{},{force:false},{force:false,errorOnExist:true},{force:true,errorOnExist:true}]){
    const actual=path.join(root,'actual'),expected=path.join(root,'expected');fs.writeFileSync(actual,'old');fs.writeFileSync(expected,'old')
    let a,b;try{copy.cpSync(source,actual,options)}catch(error){a=error.code}try{fs.cpSync(source,expected,options)}catch(error){b=error.code}
    assert.equal(a,b);assert.equal(fs.readFileSync(actual,'utf8'),fs.readFileSync(expected,'utf8'))
  }
})
test('symlink verbatim/default/dereference match Node promises',async()=>{
  const root=fixture(),source=path.join(root,'source/link');fs.symlinkSync('a',source)
  for(const [index,options]of [{},{verbatimSymlinks:true},{dereference:true}].entries()){
    const actual=path.join(root,'actual'+index),expected=path.join(root,'expected'+index)
    copy.cpSync(source,actual,options);await fs.promises.cp(source,expected,options)
    assert.equal(fs.lstatSync(actual).isSymbolicLink(),fs.lstatSync(expected).isSymbolicLink())
    if(options.dereference)assert.equal(fs.readFileSync(actual,'utf8'),'a');else assert.equal(fs.readlinkSync(actual),fs.readlinkSync(expected))
  }
})
test('filters and unsupported settings reject without silently copying',async()=>{
  const root=fixture(),source=path.join(root,'source/a'),destination=path.join(root,'copy')
  copy.cpSync(source,destination,{filter:()=>false});assert.equal(fs.existsSync(destination),false)
  assert.throws(()=>copy.cpSync(source,destination,{filter:async()=>true}),{code:'ERR_INVALID_RETURN_VALUE'})
  for(const options of [{preserveTimestamps:true},{mode:2},{unknown:true}])assert.throws(()=>copy.cpSync(source,destination,options),{code:'ERR_UNSUPPORTED_OPERATION'})
  await assert.rejects(copy.cp(source,destination,{filter:async()=>{throw Error('filter failed')}}),/filter failed/)
  assert.equal(fs.existsSync(destination),false)
})
test('copy into itself including a symlinked destination ancestor is rejected',()=>{
  const root=fixture(),source=path.join(root,'source');fs.symlinkSync(source,path.join(root,'alias'))
  for(const target of [source,path.join(source,'child'),path.join(root,'alias/child')])assert.throws(()=>copy.cpSync(source,target,{recursive:true}),{code:'ERR_FS_CP_EINVAL'})
})
