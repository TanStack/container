import {expect,test,vi} from 'vitest'
import fs,{readFile,readFileSync,readdir,writeFileSync,vol,promises,resetVolume,restoreVolumeSnapshot,snapshotVolume} from '../src/vite-browser/node-fs'
import {readFile as readFilePromises} from '../src/vite-browser/node-fs-promises'
import {getNativeSyncFileClient,setNativeSyncFileClient,readdirSync,receiveNativeFileEvent} from '../src/vite-browser/node-fs'
import {Volume} from 'memfs'
import {NativeTerminalFileSession} from '../src/native/terminal-file-session'

test('scratch metadata, listing, rename and unlink use the container volume',async()=>{
  const previous=getNativeSyncFileClient()
  const volume=Volume.fromJSON({'/app/main.js':''})
  const session=new NativeTerminalFileSession(volume)
  setNativeSyncFileClient({call:(method:string,args:unknown[])=>session.call(method,args)} as any)
  try{
    fs.writeFileSync('/tmp/first.txt','scratch')
    expect(fs.existsSync('/tmp/first.txt')).toBe(true)
    expect(fs.statSync('/tmp/first.txt').size).toBe(7)
    expect(fs.lstatSync('/tmp/first.txt').isFile()).toBe(true)
    expect(fs.readdirSync('/tmp')).toEqual(['first.txt'])
    await promises.rename('/tmp/first.txt','/tmp/second.txt')
    expect(fs.readFileSync('/tmp/second.txt','utf8')).toBe('scratch')
    await promises.unlink('/tmp/second.txt')
    expect(fs.existsSync('/tmp/second.txt')).toBe(false)
  }finally{setNativeSyncFileClient(previous);session.close()}
})

test('temporary directory APIs create private unique directories through the live filesystem',async()=>{
  const previous=getNativeSyncFileClient()
  const directories=new Set<string>()
  const call=vi.fn((operation:string,args:any[])=>{
    expect(operation).toBe('mkdir');expect(args[1]).toBe(false);expect(args[2]).toBe(0o700)
    if(directories.has(args[0]))throw Object.assign(Error('exists'),{code:'EEXIST'})
    directories.add(args[0])
  })
  setNativeSyncFileClient({call} as any)
  try{
    const first=fs.mkdtempSync('/app/tmp-') as string
    expect(first).toMatch(/^\/app\/tmp-[a-zA-Z0-9]{6}$/)
    const second=await promises.mkdtemp('/app/tmp-',{encoding:'buffer'}) as Buffer
    expect(Buffer.isBuffer(second)).toBe(true)
    expect(second.toString()).not.toBe(first)
    await new Promise<void>((resolve,reject)=>fs.mkdtemp('/app/tmp-',(error,value)=>{
      if(error){reject(error);return}expect(directories.has(value as string)).toBe(true);resolve()
    }))
    expect(directories.size).toBe(3)
  }finally{setNativeSyncFileClient(previous)}
})

test('live polling watchers share handles, deliver current and previous stats and remove individual listeners',()=>{
  vi.useFakeTimers()
  const previous=getNativeSyncFileClient()
  let size=6
  setNativeSyncFileClient({call(){return {size,nlink:1,ino:1,mode:0o100644,mtimeMs:size,ctimeMs:size,
    atimeMs:0,birthtimeMs:0,kind:'file'}}} as any)
  try{
    const first=vi.fn(),second=vi.fn()
    const watcher=fs.watchFile('/app/poll.txt',{interval:20,persistent:false},first)
    expect(fs.watchFile('/app/poll.txt',{interval:40},second)).toBe(watcher)
    vi.advanceTimersByTime(20)
    expect(first).not.toHaveBeenCalled()
    size=16;vi.advanceTimersByTime(20)
    expect(first.mock.calls[0][0].size).toBe(16)
    expect(first.mock.calls[0][1].size).toBe(6)
    expect(second).toHaveBeenCalledTimes(1)
    fs.unwatchFile('/app/poll.txt',first)
    size=20;vi.advanceTimersByTime(20)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    expect(watcher.ref()).toBe(watcher)
    expect(watcher.unref()).toBe(watcher)
    fs.unwatchFile('/app/poll.txt')
    expect(vi.getTimerCount()).toBe(0)
  }finally{setNativeSyncFileClient(previous);vi.useRealTimers()}
})

test('missing polling targets emit zero bigint stats once and bridge reset closes polling handles',()=>{
  vi.useFakeTimers()
  const previous=getNativeSyncFileClient()
  setNativeSyncFileClient({call(){throw Object.assign(Error('missing'),{code:'ENOENT'})}} as any)
  try{
    const listener=vi.fn()
    fs.watchFile('/app/missing.txt',{interval:20,bigint:true,persistent:false},listener)
    vi.advanceTimersByTime(60)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].size).toBe(0n)
    expect(listener.mock.calls[0][0].mtime.getTime()).toBe(0)
    expect(listener.mock.calls[0][0].isFile()).toBe(false)
    setNativeSyncFileClient(undefined)
    expect(vi.getTimerCount()).toBe(0)
  }finally{setNativeSyncFileClient(previous);vi.useRealTimers()}
})

test('polling deletion and recreation match Node previous-stat behavior',()=>{
  vi.useFakeTimers()
  const previous=getNativeSyncFileClient()
  let size:number|undefined=6
  setNativeSyncFileClient({call(){
    if(size===undefined)throw Object.assign(Error('missing'),{code:'ENOENT'})
    return {size,nlink:1,ino:1,mode:0o100644,mtimeMs:size,ctimeMs:size,atimeMs:0,birthtimeMs:0,kind:'file'}
  }} as any)
  try{
    const events:number[][]=[]
    fs.watchFile('/app/recreated.txt',{interval:20,persistent:false},(current,old)=>events.push([Number(current.size),Number(old.size)]))
    size=undefined;vi.advanceTimersByTime(20)
    vi.advanceTimersByTime(40)
    size=9;vi.advanceTimersByTime(20)
    expect(events).toEqual([[0,6],[9,6]])
    fs.unwatchFile('/app/recreated.txt')
    expect(vi.getTimerCount()).toBe(0)
  }finally{setNativeSyncFileClient(previous);vi.useRealTimers()}
})

test('polling options distinguish an omitted interval from explicitly invalid values',()=>{
  vi.useFakeTimers()
  const previous=getNativeSyncFileClient()
  setNativeSyncFileClient({call(){return {size:1,nlink:1,ino:1,mode:0o100644,mtimeMs:0,ctimeMs:0,
    atimeMs:0,birthtimeMs:0,kind:'file'}}} as any)
  try{
    for(const interval of [null,undefined,'20']){
      expect(()=>fs.watchFile('/app/options.txt',{interval} as any,()=>{})).toThrow(expect.objectContaining({code:'ERR_INVALID_ARG_TYPE'}))
    }
    for(const interval of [-1,1.5,NaN,Infinity]){
      expect(()=>fs.watchFile('/app/options.txt',{interval},()=>{})).toThrow(expect.objectContaining({code:'ERR_OUT_OF_RANGE'}))
    }
    expect(vi.getTimerCount()).toBe(0)
    fs.watchFile('/app/options.txt',{persistent:false},()=>{})
    expect(vi.getTimerCount()).toBe(1)
    fs.unwatchFile('/app/options.txt')
  }finally{setNativeSyncFileClient(previous);vi.useRealTimers()}
})

test('live directory and symlink reads use the bridge across API forms',async()=>{
  vol.mkdirSync('/app/live-directory/sub',{recursive:true})
  vol.writeFileSync('/app/live-directory/sub/file.txt','')
  vol.symlinkSync('sub','/app/live-directory/link')
  const previous=getNativeSyncFileClient()
  setNativeSyncFileClient({call(method:string,args:unknown[]){
    const path=args[0] as string
    if(method==='readdir')return vol.readdirSync(path).map(String)
    if(method==='readlink')return String(vol.readlinkSync(path))
    if(method==='realpath')return String(vol.realpathSync(path))
    if(method==='access')return vol.accessSync(path,args[1] as number)
    if(method==='mkdir')return vol.mkdirSync(path,{recursive:args[1] as boolean,mode:args[2] as number})
    if(method==='rename')return vol.renameSync(path,args[1] as string)
    if(method==='unlink')return vol.unlinkSync(path)
    if(method==='lstat'||method==='stat'){
      const stat=method==='lstat'?vol.lstatSync(path):vol.statSync(path)
      return {...stat,kind:stat.isDirectory()?'directory':stat.isSymbolicLink()?'symlink':'file'}
    }
    throw Error(`Unexpected method ${method}`)
  }} as any)
  try{
    expect((readdirSync('/app/live-directory',{recursive:true}) as string[]).sort()).toEqual(['link','sub','sub/file.txt'])
    expect((readdirSync('/app/live-directory','buffer') as Buffer[]).map(value=>value.toString()).sort()).toEqual(['link','sub'])
    const entries=readdirSync('/app/live-directory',{withFileTypes:true,recursive:true}) as any[]
    const file=entries.find(entry=>entry.name==='file.txt')
    expect(file).toBeInstanceOf(fs.Dirent)
    expect(file.parentPath).toBe('/app/live-directory/sub')
    expect(file.isFile()).toBe(true)
    for(const method of ['isBlockDevice','isCharacterDevice','isFIFO','isSocket'])expect(file[method]()).toBe(false)
    expect(entries.find(entry=>entry.name==='link').isSymbolicLink()).toBe(true)
    const link=new URL('file:///app/live-directory/link')
    expect(fs.readlinkSync(link)).toBe('sub')
    expect((await fs.promises.readlink(link,{encoding:'buffer'})).toString()).toBe('sub')
    expect(await new Promise((resolve,reject)=>fs.readlink(link,(error,value)=>error?reject(error):resolve(value)))).toBe('sub')
    const linkStat=await new Promise<any>((resolve,reject)=>fs.lstat(link,(error,value)=>error?reject(error):resolve(value)))
    expect(linkStat).toBeInstanceOf(fs.Stats)
    expect(linkStat.isSymbolicLink()).toBe(true)
    const directoryStat=await new Promise<any>((resolve,reject)=>fs.stat('/app/live-directory/sub',{bigint:true},(error,value)=>error?reject(error):resolve(value)))
    expect(directoryStat.isDirectory()).toBe(true)
    const events:any[]=[]
    expect(()=>fs.watch('/app/live-directory',{signal:{} as AbortSignal})).toThrow('AbortSignal')
    expect(()=>fs.watch('/app/live-directory',3 as any)).toThrow('Options must')
    const watcher=fs.watch('/app/live-directory',{recursive:true,encoding:'buffer',persistent:false},(event,name)=>events.push([event,name.toString()]))
    receiveNativeFileEvent('change','/app/live-directory/sub/file.txt')
    receiveNativeFileEvent('rename','/app/elsewhere.txt')
    expect(events).toEqual([['change','sub/file.txt']])
    expect(watcher.ref()).toBe(watcher)
    expect(watcher.unref()).toBe(watcher)
    watcher.close()
    receiveNativeFileEvent('change','/app/live-directory/sub/file.txt')
    expect(events).toHaveLength(1)
    const directEvents:string[]=[]
    const direct=fs.watch('/app/live-directory',{persistent:false},(_event,name)=>directEvents.push(String(name)))
    receiveNativeFileEvent('change','/app/live-directory/sub/file.txt')
    receiveNativeFileEvent('rename','/app/live-directory/direct.txt')
    expect(directEvents).toEqual(['direct.txt'])
    direct.close()
    const controller=new AbortController()
    const aborted=fs.watch('/app/live-directory/sub/file.txt',{signal:controller.signal,persistent:false})
    let closed=false;aborted.on('close',()=>{closed=true})
    controller.abort();await Promise.resolve()
    expect(closed).toBe(true)
    const iterator=fs.promises.watch('/app/live-directory',{persistent:false})
    const next=iterator.next()
    receiveNativeFileEvent('rename','/app/live-directory/new.txt')
    expect(await next).toEqual({done:false,value:{eventType:'rename',filename:'new.txt'}})
    const pending=iterator.next()
    await iterator.return!()
    expect(await pending).toEqual({done:true,value:undefined})
    const abortWatch=new AbortController()
    const abortIterator=fs.promises.watch('/app/live-directory',{signal:abortWatch.signal,persistent:false})
    const abortNext=abortIterator.next()
    abortWatch.abort()
    await expect(abortNext).rejects.toMatchObject({name:'AbortError',code:'ABORT_ERR'})
    await new Promise<void>((resolve,reject)=>fs.access(new URL('file:///app/live-directory/sub/file.txt'),error=>error?reject(error):resolve()))
    await fs.promises.access('/app/live-directory/sub/file.txt',fs.constants.R_OK)
    await expect(fs.promises.access('/app/live-directory/missing')).rejects.toMatchObject({code:'ENOENT'})
    expect(typeof directoryStat.mtimeMs).toBe('bigint')
    expect(await fs.promises.realpath(link)).toBe('/app/live-directory/sub')
    expect(await new Promise((resolve,reject)=>fs.realpath.native(link,(error,value)=>error?reject(error):resolve(value)))).toBe('/app/live-directory/sub')
    await new Promise((resolve,reject)=>fs.mkdir('/app/live-directory/new/deep',{recursive:true,mode:0o700},(error,value)=>error?reject(error):resolve(value)))
    expect(vol.existsSync('/app/live-directory/new/deep')).toBe(true)
    expect(vol.statSync('/app/live-directory/new/deep').mode&0o777).toBe(0o700)
    fs.mkdirSync('/app/live-directory/octal','750')
    expect(vol.statSync('/app/live-directory/octal').mode&0o777).toBe(0o750)
    expect(()=>fs.mkdirSync('/app/live-directory/invalid',{mode:'wrong'})).toThrow('Invalid directory mode')
    await new Promise<void>((resolve,reject)=>fs.rename('/app/live-directory/sub/file.txt','/app/live-directory/new/deep/moved.txt',error=>error?reject(error):resolve()))
    expect(vol.existsSync('/app/live-directory/new/deep/moved.txt')).toBe(true)
    await new Promise<void>((resolve,reject)=>fs.unlink('/app/live-directory/new/deep/moved.txt',error=>error?reject(error):resolve()))
    expect(vol.existsSync('/app/live-directory/new/deep/moved.txt')).toBe(false)
  }finally{setNativeSyncFileClient(previous);vol.rmSync('/app/live-directory',{recursive:true})}
})

test('callback readdir accepts file URLs, dirents and asynchronous errors',async()=>{
  vol.mkdirSync('/app/readdir-probe',{recursive:true})
  vol.writeFileSync('/app/readdir-probe/test.js','')
  try{
    const entries=await new Promise<any[]>((resolve,reject)=>
      readdir(new URL('file:///app/readdir-probe'),{withFileTypes:true},(error,value)=>error?reject(error):resolve(value)))
    expect(entries.map(entry=>[entry.name,entry.isFile()])).toEqual([['test.js',true]])
    await expect(new Promise((resolve,reject)=>readdir('/app/no-readdir-probe',(error,value)=>error?reject(error):resolve(value)))).rejects.toThrow()
  }finally{vol.rmSync('/app/readdir-probe',{recursive:true})}
})

test('callback and promise fs reads accept local file URLs',async()=>{
  const path='/app/native-file-url-probe.txt'
  vol.mkdirSync('/app',{recursive:true})
  vol.writeFileSync(path,'file url content')
  try{
    const url=new URL(`file://${path}`)
    const callbackResult=await new Promise<string>((resolve,reject)=>
      readFile(url,'utf8',(error,value)=>error?reject(error):resolve(value as string)))
    expect(callbackResult).toBe('file url content')
    expect(await promises.readFile(url,'utf8')).toBe('file url content')
    expect(await readFilePromises(url,'utf8')).toBe('file url content')
    await expect(promises.readFile(new URL('https://example.com/file'),'utf8')).rejects.toThrow('Only local file URLs')
  }finally{vol.unlinkSync(path)}
})

test('default fs export uses the live adapter methods',()=>{
  expect(fs.readFileSync).toBe(readFileSync)
  expect(fs.writeFileSync).toBe(writeFileSync)
  expect(fs.promises).toBe(promises)
})

test('statSync and lstatSync honor throwIfNoEntry false',()=>{
  vol.mkdirSync('/app',{recursive:true})
  const missing='/app/missing-env-file'
  expect(fs.statSync(missing,{throwIfNoEntry:false})).toBeUndefined()
  expect(fs.lstatSync(missing,{throwIfNoEntry:false})).toBeUndefined()
  expect(()=>fs.statSync(missing)).toThrow()
})

test('stat APIs return bigint timestamps when requested',async()=>{
  vol.mkdirSync('/app',{recursive:true})
  const file='/app/bigint-stat-probe.txt'
  vol.writeFileSync(file,'content')
  try{
    expect(typeof fs.statSync(file,{bigint:true})?.mtimeMs).toBe('bigint')
    expect(typeof fs.lstatSync(file,{bigint:true})?.mtimeMs).toBe('bigint')
    expect(typeof (await fs.promises.stat(file,{bigint:true})).mtimeMs).toBe('bigint')
    const handle=await fs.promises.open(file,'r')
    try{expect(typeof (await handle.stat({bigint:true})).mtimeMs).toBe('bigint')}
    finally{await handle.close()}
  }finally{vol.unlinkSync(file)}
})

test('package manifests read through file URLs come from the workspace',()=>{
  const path='/app/node_modules/example/package.json'
  vol.mkdirSync('/app/node_modules/example',{recursive:true})
  vol.writeFileSync(path,'{"name":"example","version":"1.2.3"}')
  try{
    expect(readFileSync(new URL(`file://${path}`),'utf8')).toBe('{"name":"example","version":"1.2.3"}')
  }finally{vol.unlinkSync(path)}
})

test('native workspace snapshot preserves empty directories, links, and modes',()=>{
  resetVolume({'/app/data.bin':new Uint8Array([0,127,255])})
  vol.mkdirSync('/app/empty')
  vol.chmodSync('/app/empty',0o700)
  vol.chmodSync('/app/data.bin',0o600)
  vol.symlinkSync('data.bin','/app/data-link')
  vol.symlinkSync('missing','/app/dangling-link')
  vol.utimesSync('/app/data.bin',new Date(1700000000000),new Date(1700000001000))
  vol.utimesSync('/app/empty',new Date(1700000002000),new Date(1700000003000))
  const snapshot=snapshotVolume()
  expect(snapshot.version).toBe(5)
  expect(snapshot.directories).toContain('/app/empty')
  expect(snapshot.symlinks).toEqual({'/app/data-link':'data.bin','/app/dangling-link':'missing'})
  expect(snapshot.fileTimes?.['/app/data.bin']).toEqual({atimeMs:1700000000000,mtimeMs:1700000001000})
  expect(snapshot.directoryTimes?.['/app/empty']).toEqual({atimeMs:1700000002000,mtimeMs:1700000003000})
  restoreVolumeSnapshot(snapshot)
  expect(vol.readdirSync('/app')).toContain('empty')
  expect(vol.lstatSync('/app/empty').mode&0o777).toBe(0o700)
  expect(vol.lstatSync('/app/data.bin').mode&0o777).toBe(0o600)
  expect(vol.statSync('/app/data.bin').mtimeMs).toBe(1700000001000)
  expect(vol.statSync('/app/empty').mtimeMs).toBe(1700000003000)
  expect(vol.readlinkSync('/app/dangling-link')).toBe('missing')
  expect([...vol.readFileSync('/app/data-link') as Uint8Array]).toEqual([0,127,255])
})
