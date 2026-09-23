import { describe, expect, test } from 'vitest'
import { WorkspaceFiles, workspacePath } from '../src/sandbox/files'
import {fileCall,fileCallSync} from '../src/sandbox/file-capability'

describe('workspace filesystem', () => {
  test('invalid directory modes and unsupported flush do not silently mutate storage',()=>{
    const fs=new WorkspaceFiles({'/file':'before'}),before=fs.snapshot()
    for(const option of [{flush:true},{signal:{aborted:false}}]){
      expect(()=>fileCallSync(fs,true,'writeFile',['/file',new Uint8Array(),option])).toThrow('ENOTSUP')
    }
    for(const option of [-1,{mode:'888'}])expect(()=>fileCallSync(fs,true,'mkdir',['/private',option])).toThrow('EINVAL')
    expect(fs.snapshot()).toEqual(before)
  })
  test('empty directories survive snapshots, copies, and legacy restoration',()=>{
    const fs=new WorkspaceFiles({'/old/file':'x'})
    fs.mkdirSync('/empty');fs.mkdirSync('/deep/nested',true)
    const saved=fs.snapshot(),restored=new WorkspaceFiles()
    expect(saved.version).toBe(5);restored.replace(saved)
    expect(restored.isDirectorySync('/empty')).toBe(true)
    expect(restored.readdirSync('/empty')).toEqual([])
    expect(restored.isDirectorySync('/deep/nested')).toBe(true)
    restored.unlinkSync('/old/file');expect(restored.isDirectorySync('/old')).toBe(true)
    restored.replace({version:1,files:{'/legacy/file':new Uint8Array([3])}})
    expect(restored.isDirectorySync('/legacy')).toBe(true)
    expect(restored.existsSync('/empty')).toBe(false)
  })
  test('directory quotas and invalid restores commit nothing',()=>{
    const fs=new WorkspaceFiles({},8,3),events:unknown[]=[]
    fs.subscribe(event=>events.push(event));fs.mkdirSync('/a/b',true)
    const before=fs.snapshot(),revision=fs.revision
    expect(()=>fs.mkdirSync('/c/d',true)).toThrow('ENOSPC')
    expect(()=>fs.writeFileSync('/c/d/file',new Uint8Array())).toThrow('ENOSPC')
    expect(()=>fs.replace({version:2,files:{'/a':new Uint8Array()},directories:['/a/b']})).toThrow('ENOTDIR')
    expect(fs.snapshot()).toEqual(before);expect(fs.revision).toBe(revision);expect(events).toHaveLength(2)
  })
  test('copy, append, overwrite, and truncate reject quota overflow atomically',()=>{
    const fs=new WorkspaceFiles({'/file':'abc'},5),before=fs.snapshot(),revision=fs.revision,events:unknown[]=[]
    fs.subscribe(event=>events.push(event))
    for(const [method,args] of [
      ['copyFile',['/file','/copy']],
      ['writeFile',['/file',new Uint8Array(3),{flag:'a'}]],
      ['writeFile',['/file',new Uint8Array(6),{flag:'r+'}]],
      ['writeFile',['/file',new Uint8Array(6)]],
      ['truncate',['/file',6]],
    ] as [string,unknown[]][]){
      expect(()=>fileCallSync(fs,true,method,args)).toThrow('ENOSPC')
      expect(fs.snapshot()).toEqual(before);expect(fs.revision).toBe(revision)
    }
    expect(events).toEqual([])
  })
  test('rename moves directory subtrees and validates before committing',()=>{
    const fs=new WorkspaceFiles({'/from/deep/file':'value','/occupied/file':'existing'})
    fs.mkdirSync('/from/empty');fs.mkdirSync('/target')
    fs.renameSync('/from','/target')
    expect(fs.isDirectorySync('/target/empty')).toBe(true)
    expect(fs.readFileSync('/target/deep/file')).toEqual(new TextEncoder().encode('value'))
    const saved=fs.snapshot(),revision=fs.revision
    expect(()=>fs.renameSync('/target','/target/deep/child')).toThrow('EINVAL')
    expect(()=>fs.renameSync('/target','/occupied')).toThrow('ENOTEMPTY')
    expect(()=>fs.renameSync('/target','/'+'a'.repeat(4096))).toThrow('ENAMETOOLONG')
    // The destination itself fits, but a descendant would exceed the limit.
    expect(()=>fs.renameSync('/target','/'+'a'.repeat(4090))).toThrow('ENAMETOOLONG')
    expect(fs.snapshot()).toEqual(saved);expect(fs.revision).toBe(revision)
    fs.rmSync('/target',{recursive:true});expect(fs.existsSync('/target')).toBe(false)
    expect(fs.readFileSync('/occupied/file').length).toBe(8)
  })
  test('Node writes require parents while host editing can create them',()=>{
    const fs=new WorkspaceFiles()
    expect(()=>fileCallSync(fs,true,'writeFile',['/missing/file',new Uint8Array()])).toThrow('ENOENT')
    expect(fs.existsSync('/missing')).toBe(false)
    fs.writeFileSync('/created/file',new Uint8Array([1]))
    expect(fs.isDirectorySync('/created')).toBe(true)
    fileCallSync(fs,true,'mkdir',['/empty'])
    expect(fileCallSync(fs,false,'stat',['/empty'])).toMatchObject({kind:'directory',size:0,mode:0o40755})
    expect(()=>fileCallSync(fs,false,'rename',['/created','/renamed'])).toThrow('EACCES')
    expect(()=>fileCallSync(fs,false,'rm',['/created',{recursive:true}])).toThrow('EACCES')
  })
  test('path and file-count limits include empty files and failed restores',async()=>{
    const fs=new WorkspaceFiles({},32,2)
    await fs.writeText('/a','');await fs.writeText('/b','')
    await expect(fs.writeText('/c','')).rejects.toThrow('file-count quota')
    await fs.writeText('/a','existing')
    expect(()=>fs.replace({version:1,files:{'/c':new Uint8Array(),'/d':new Uint8Array(),'/e':new Uint8Array()}})).toThrow('file-count quota')
    expect(await fs.list()).toEqual(['/a','/b'])
    expect(()=>workspacePath('/'+'a'.repeat(4096))).toThrow('ENAMETOOLONG')
    expect(()=>workspacePath('/'+'é'.repeat(2048))).toThrow('ENAMETOOLONG')
    expect(()=>new WorkspaceFiles({},NaN)).toThrow('Invalid workspace limits')
  })
  test('subscriptions see committed writes, patches, restores, and removals only',async()=>{
    const fs=new WorkspaceFiles({'/a':'before'},32),events:unknown[]=[]
    const unsubscribe=fs.subscribe(event=>events.push(event))
    const checkpoint=fs.snapshot()
    await fs.writeText('/b','new')
    await fs.patch('/a','before','after')
    await expect(fs.writeText('/a','x'.repeat(33))).rejects.toThrow('ENOSPC')
    fs.replace(checkpoint)
    await fs.remove('/a')
    expect(events).toEqual([
      {path:'/b',eventType:'rename'},{path:'/a',eventType:'change'},
      {path:'/b',eventType:'rename'},{path:'/a',eventType:'change'},{path:'/a',eventType:'rename'},
    ])
    unsubscribe();await fs.writeText('/a','unobserved');expect(events).toHaveLength(5)
  })
  test('sync and async capabilities share storage, copies, and authority',async()=>{
    const fs=new WorkspaceFiles({'/a':'before'},10)
    fileCallSync(fs,true,'writeFile',['/a',new TextEncoder().encode('after')])
    expect(await fileCall(fs,false,'readFile',['/a','utf8'])).toBe('after')
    const bytes=fileCallSync(fs,false,'readFile',['/a']) as Uint8Array
    bytes.fill(0)
    expect(fileCallSync(fs,false,'readFile',['/a','utf8'])).toBe('after')
    expect(()=>fileCallSync(fs,false,'writeFile',['/b',new Uint8Array(1)])).toThrow('read-only')
    expect(()=>fileCallSync(fs,true,'writeFile',['/b',new Uint8Array(10)])).toThrow('ENOSPC')
    expect(()=>fileCallSync(fs,true,'readFile',['../escape'])).toThrow('EACCES')
    expect(fileCallSync(fs,false,'readdir',['/'])).toEqual(['a'])
    expect(fileCallSync(fs,false,'stat',['/a'])).toMatchObject({kind:'file',size:5,mode:0o100644})
    fs.close()
    expect(()=>fs.readFileSync('/a')).toThrow('closed')
  })
  test('rejects escaping and ambiguous paths', () => {
    expect(() => workspacePath('../secret')).toThrow('EACCES')
    expect(() => workspacePath('/a/../../secret')).toThrow('EACCES')
    expect(() => workspacePath('C:\\secret')).toThrow('EINVAL')
    expect(workspacePath('/a/../b')).toBe('/b')
  })
  test('copies input and output bytes', async () => {
    const input = new Uint8Array([255, 0, 192])
    const fs = new WorkspaceFiles({ '/binary': input })
    input.fill(0)
    const output = await fs.readFile('/binary')
    output.fill(1)
    expect([...(await fs.readFile('/binary'))]).toEqual([255, 0, 192])
    const snapshot = fs.snapshot()
    snapshot.files['/binary'].fill(2)
    expect([...(await fs.readFile('/binary'))]).toEqual([255, 0, 192])
  })
  test('failed quota and snapshot commits leave the original intact', async () => {
    const fs = new WorkspaceFiles({ '/a': 'a' }, 3)
    await expect(fs.writeText('/b', 'xxx')).rejects.toThrow('ENOSPC')
    expect(await fs.list()).toEqual(['/a'])
    expect(() =>
      fs.replace({ version: 1, files: { '/b': new Uint8Array(4) } }),
    ).toThrow('ENOSPC')
    expect(await fs.readText('/a')).toBe('a')
  })
  test('enforces file/directory distinctions', async () => {
    const fs = new WorkspaceFiles({ '/a/b': 'b' })
    await expect(fs.writeText('/a', 'a')).rejects.toThrow('EISDIR')
    await expect(fs.writeText('/a/b/c', 'c')).rejects.toThrow('ENOTDIR')
    expect(() => new WorkspaceFiles({ '/a': '', '/a/b': '' })).toThrow(
      'ENOTDIR',
    )
  })
  test('exact patches and optimistic commits reject conflicts', async () => {
    const fs = new WorkspaceFiles({ '/a': 'hello hello', '/b': 'before' })
    await expect(fs.patch('/a', 'hello', 'bye')).rejects.toThrow('ECONFLICT')
    const revision = fs.revision
    const snapshot = fs.snapshot()
    await fs.patch('/b', 'before', 'after')
    expect(() => fs.replace(snapshot, revision)).toThrow('ECONFLICT')
    expect(await fs.readText('/b')).toBe('after')
  })
  test('close invalidates retained filesystem references', async () => {
    const fs = new WorkspaceFiles({ '/a': 'a' })
    fs.close()
    await expect(fs.writeText('/b', 'b')).rejects.toThrow('closed')
    expect(() => fs.snapshot()).toThrow('closed')
  })
  test('snapshot commits preserve metadata for unchanged files',()=>{
    const fs=new WorkspaceFiles({'/vite.config.ts':'export default {}','/generated.js':'one'})
    try{
      const before=fs.statSync('/vite.config.ts'),snapshot=fs.snapshot()
      fs.replace(snapshot)
      expect(fs.statSync('/vite.config.ts')).toMatchObject({mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs})
      snapshot.files['/generated.js']=new TextEncoder().encode('two')
      fs.replace(snapshot)
      expect(fs.statSync('/vite.config.ts')).toMatchObject({mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs})
    }finally{fs.close()}
  })
})
