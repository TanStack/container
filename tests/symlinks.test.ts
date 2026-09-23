import {test,expect} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'
import {fileCallSync} from '../src/sandbox/file-capability'
import {ModuleResolver} from '../src/sandbox/module-resolver'

const bytes=(value:string)=>new TextEncoder().encode(value)

test('links resolve components before dot-dot and retain their stored target',()=>{
  const fs=new WorkspaceFiles({'/real/deep/file':'value','/real/sibling':'correct','/sibling':'wrong'})
  fs.symlinkSync('real/deep','/alias');fs.symlinkSync('/alias/file','/absolute')
  expect(fs.realpathSync('/absolute')).toBe('/real/deep/file')
  expect(fs.readlinkSync('/alias')).toBe('real/deep')
  expect(fileCallSync(fs,false,'readFile',['/alias/../sibling','utf8'])).toBe('correct')
  expect(fs.statSync('/absolute')).toMatchObject({kind:'file',size:5,mode:0o100644})
  expect(fs.statSync('/absolute',false)).toMatchObject({kind:'symlink',size:11,mode:0o120777})
  fs.writeFileSync('/absolute',bytes('new'),false)
  expect(fs.readFileSync('/real/deep/file')).toEqual(bytes('new'))
})

test('dangling links remain entries and exclusive writes do not replace them',()=>{
  const fs=new WorkspaceFiles();fs.symlinkSync('missing','/link')
  expect(fs.existsSync('/link')).toBe(false);expect(fs.entryExistsSync('/link')).toBe(true)
  for(const flag of ['wx','ax','wx+','ax+'])expect(()=>fileCallSync(fs,true,'writeFile',['/link',bytes('x'),{flag}])).toThrow('EEXIST')
  expect(()=>fs.readFileSync('/link')).toThrow('ENOENT')
  fs.writeFileSync('/link',bytes('created'),false)
  expect(fs.readFileSync('/missing')).toEqual(bytes('created'));expect(fs.readlinkSync('/link')).toBe('missing')
})

test('empty paths and file trailing slashes fail without mutating their targets',()=>{
  const fs=new WorkspaceFiles({'/file':'safe'});fs.symlinkSync('file','/link')
  const before=fs.snapshot()
  expect(fs.existsSync('')).toBe(false)
  for(const path of ['/file/','/link/']){
    for(const method of ['readFile','unlink','rm'])expect(()=>fileCallSync(fs,true,method,[path])).toThrow('ENOTDIR')
    expect(()=>fs.renameSync(path,'/moved')).toThrow('ENOTDIR')
  }
  expect(fs.snapshot()).toEqual(before)
  fs.mkdirSync('/empty/');fs.renameSync('/empty','/renamed/')
  expect(fs.isDirectorySync('/renamed')).toBe(true)
})

test('loop and workspace escape failures leave files and revisions unchanged',()=>{
  const fs=new WorkspaceFiles({'/keep':'safe'})
  fs.symlinkSync('b','/a');fs.symlinkSync('a','/b');fs.symlinkSync('../keep','/escape')
  const before=fs.snapshot(),revision=fs.revision
  for(const method of ['realpath','stat','readFile','writeFile'])expect(()=>fileCallSync(fs,true,method,['/a',bytes('x')])).toThrow('ELOOP')
  expect(()=>fs.readFileSync('/escape')).toThrow('EACCES')
  expect(()=>fs.writeFileSync('/escape',bytes('x'))).toThrow('EACCES')
  expect(fs.existsSync('/a')).toBe(false);expect(fs.readlinkSync('/a')).toBe('b')
  expect(fs.snapshot()).toEqual(before);expect(fs.revision).toBe(revision)
})

test('unlink, rename, and recursive removal operate on final links, not targets',()=>{
  const fs=new WorkspaceFiles({'/real/file':'safe'})
  fs.symlinkSync('/real','/alias');fs.renameSync('/alias','/moved')
  expect(fs.readlinkSync('/moved')).toBe('/real')
  expect(()=>fs.rmdirSync('/moved')).toThrow('ENOTDIR')
  fs.rmSync('/moved',{recursive:true});expect(fs.readFileSync('/real/file')).toEqual(bytes('safe'))
  fs.mkdirSync('/tree');fs.symlinkSync('/real','/tree/external');fs.rmSync('/tree',{recursive:true})
  fs.symlinkSync('/real/file','/alias');fs.unlinkSync('/alias')
  expect(fs.readFileSync('/real/file')).toEqual(bytes('safe'))
})

test('link targets and empty directories survive moves and snapshot restoration',async()=>{
  const fs=new WorkspaceFiles({'/tree/file':'before'});fs.mkdirSync('/tree/empty')
  fs.symlinkSync('file','/tree/relative');fs.renameSync('/tree','/moved')
  const saved=fs.snapshot();expect(saved.version).toBe(5)
  await fs.patch('/moved/relative','before','after')
  expect(fs.readFileSync('/moved/file')).toEqual(bytes('after'))
  fs.replace(saved);expect(fs.readlinkSync('/moved/relative')).toBe('file')
  expect(fs.readFileSync('/moved/relative')).toEqual(bytes('before'))
  expect(fs.isDirectorySync('/moved/empty')).toBe(true)
})

test('invalid link snapshots and quota failures are atomic',()=>{
  const fs=new WorkspaceFiles({'/keep':'x'},8,3),before=fs.snapshot(),revision=fs.revision
  const invalid:Record<string,string>[]=[{'/keep':'other'},{'/parent':'target','/parent/child':'other'},{'/link':'long-target'}]
  for(const symlinks of invalid){
    expect(()=>fs.replace({version:3,files:before.files,directories:[],symlinks})).toThrow()
    expect(fs.snapshot()).toEqual(before);expect(fs.revision).toBe(revision)
  }
  expect(()=>fs.symlinkSync('long-target','/link')).toThrow('ENOSPC')
  fs.symlinkSync('keep','/link');expect(fs.byteLength).toBe(5)
  const events:unknown[]=[];fs.subscribe(event=>events.push(event))
  fs.replace({version:3,files:before.files,directories:[],symlinks:{'/link':'absent'}})
  expect(events).toEqual([{path:'/link',eventType:'rename'}])
})

test('archive writes refuse linked ancestors and final filenames',async()=>{
  const fs=new WorkspaceFiles({'/private/value':'safe'});fs.mkdirSync('/node_modules/pkg',true)
  fs.symlinkSync('/private','/node_modules/pkg/dir');fs.symlinkSync('/private/value','/node_modules/pkg/file')
  const before=fs.snapshot()
  for(const path of ['/node_modules/pkg/dir/value','/node_modules/pkg/file','/node_modules/pkg/dir/../value']){
    await expect(fs.writeFile(path,bytes('bad'),{followSymlinks:false})).rejects.toThrow('ELOOP')
    expect(fs.snapshot()).toEqual(before)
  }
  await fs.writeFile('/node_modules/pkg/normal',bytes('good'),{followSymlinks:false})
  expect(fs.readFileSync('/node_modules/pkg/normal')).toEqual(bytes('good'))
})

test('module aliases share physical identity and package type, including URL suffixes',()=>{
  const fs=new WorkspaceFiles({'/real/package.json':'{"type":"module"}','/real/value.js':'','/real/addon.node':''})
  fs.mkdirSync('/node_modules');fs.symlinkSync('../real','/node_modules/pkg');fs.symlinkSync('real/value.js','/alias.cjs')
  const resolver=new ModuleResolver(fs,new Set())
  expect(resolver.resolve('./alias.cjs')).toEqual({path:'/real/value.js',id:'file:///real/value.js',kind:'module'})
  expect(resolver.resolve('./node_modules/pkg/value.js?x#y')).toEqual({path:'/real/value.js',id:'file:///real/value.js?x#y',kind:'module'})
  fs.symlinkSync('real/addon.node','/fake.js')
  expect(()=>resolver.resolve('./fake.js')).toThrow('Native addons')
})
