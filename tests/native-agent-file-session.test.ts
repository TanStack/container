import {expect,it,vi} from 'vitest'
import {NativeAgentFileSession} from '../src/native/agent-file-session'
const backend=()=>({listDirectory:vi.fn(async(path:string)=>path==='/app'?[{name:'nested',type:'directory' as const},{name:'linked',type:'symlink' as const}]:[{name:'file.txt',type:'file' as const}]),mkdir:vi.fn(async()=>{}),remove:vi.fn(async()=>{}),rename:vi.fn(async()=>{})})
it('lists relative directory entries without traversing symlinks',async()=>{
  const files=backend(),session=new NativeAgentFileSession(files)
  expect(await session.call('readdir',['/app',{recursive:true,withFileTypes:true}])).toEqual([
    {name:'linked',relativePath:'linked',kind:'symlink'},
    {name:'nested',relativePath:'nested',kind:'directory'},
    {name:'file.txt',relativePath:'nested/file.txt',kind:'file'},
  ])
  expect(files.listDirectory.mock.calls).toEqual([['/app'],['/app/nested']])
})
it('stops a directory traversal closed while an owner request is pending',async()=>{
  let finish!:(value:Array<{name:string;type:'directory'}>)=>void
  const files=backend()
  files.listDirectory.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const session=new NativeAgentFileSession(files)
  const pending=session.call('readdir',['/app',{recursive:true,withFileTypes:true}])
  const rejected=expect(pending).rejects.toThrow('closed')
  await session.close()
  finish([{name:'nested',type:'directory'}])
  await rejected
  expect(files.listDirectory).toHaveBeenCalledOnce()
})
it('rejects malformed owner entries before traversing them',async()=>{
  for(const name of ['..','nested/child','nested\\child','bad\0name']){
    const files=backend()
    files.listDirectory.mockResolvedValueOnce([{name,type:'directory'}])
    const session=new NativeAgentFileSession(files)
    await expect(session.call('readdir',['/app',{recursive:true,withFileTypes:true}])).rejects.toThrow('Invalid native directory entry')
    expect(files.listDirectory).toHaveBeenCalledOnce()
  }
})
it('rejects every mutation in a read-only capability without contacting the owner',async()=>{
  const files=backend(),session=new NativeAgentFileSession(files)
  for(const [method,args] of [['mkdir',['/app/new',{recursive:true}]],['rm',['/app/file',{recursive:true,force:false}]],['rename',['/app/old','/app/new']]] as const){
    await expect(session.call(method,[...args])).rejects.toThrow('read-only')
  }
  expect(files.mkdir).not.toHaveBeenCalled();expect(files.remove).not.toHaveBeenCalled();expect(files.rename).not.toHaveBeenCalled()
})
it('routes writable mutations directly and rejects closed/read-only/invalid requests',async()=>{
  const files=backend(),readonly=new NativeAgentFileSession(files),session=new NativeAgentFileSession(files,true)
  await expect(readonly.call('rm',['/app/file',{recursive:true,force:false}])).rejects.toThrow('read-only')
  await session.call('mkdir',['/app/new',{recursive:true}]);await session.call('rename',['/app/new','/app/moved'])
  await session.call('rm',['/app/moved',{recursive:true,force:false}])
  expect(files.mkdir).toHaveBeenCalledWith('/app/new',{recursive:true})
  expect(files.rename).toHaveBeenCalledWith('/app/new','/app/moved')
  expect(files.remove).toHaveBeenCalledWith('/app/moved',{recursive:true,force:false})
  await expect(session.call('rename',['/app/../outside','/app/new'])).rejects.toThrow('Invalid native file path')
  await expect(session.call('open',['/app/file'])).rejects.toMatchObject({code:'ERR_NOT_IMPLEMENTED'})
  await session.close();await session.close()
  await expect(session.call('readdir',['/app',{recursive:true,withFileTypes:true}])).rejects.toThrow('closed')
})
