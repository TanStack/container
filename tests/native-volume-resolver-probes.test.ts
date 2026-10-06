import {expect,test,vi} from 'vitest'
import {Volume} from 'memfs'
import {getNativeSyncFileClient,setNativeSyncFileClient} from '../src/vite-browser/node-fs'
import {NativeTerminalFileSession} from '../src/native/terminal-file-session'
import {resolveVolumeImport,volumeResolver} from '../src/native/volume-resolver'
import {builtinModules} from '../src/vite-browser/node-module'

function liveFiles(files:Record<string,string>,check:(volume:Volume,call:ReturnType<typeof vi.fn>)=>void){
  const previous=getNativeSyncFileClient(),volume=Volume.fromJSON(files)
  const session=new NativeTerminalFileSession(volume)
  const call=vi.fn((method:string,args:unknown[])=>session.call(method,args))
  setNativeSyncFileClient({call} as any)
  try{check(volume,call)}finally{setNativeSyncFileClient(previous);session.close()}
}

test('an exact live module needs one stat round trip',()=>{
  liveFiles({'/app/value.js':'export default 1'},(_volume,call)=>{
    expect(resolveVolumeImport('./value.js','/app/main.js')).toBe('/app/value.js')
    expect(call.mock.calls).toEqual([['stat',['/app/value.js']]])
  })
})

test('server builtins resolve without asking the filesystem',()=>{
  liveFiles({'/app/main.js':''},(_volume,call)=>{
    for(const name of builtinModules){
      expect(resolveVolumeImport(name,'/app/main.js')).toBe('node:'+name)
      expect(resolveVolumeImport('node:'+name,'/app/main.js')).toBe('node:'+name)
    }
    expect(call).not.toHaveBeenCalled()
  })
})

test('server builtins cannot be shadowed by packages, client packages still resolve',()=>{
  liveFiles({'/app/main.js':'','/app/node_modules/path/package.json':'{"main":"index.js"}',
    '/app/node_modules/path/index.js':'export default {}'},(_volume,call)=>{
    expect(resolveVolumeImport('path','/app/main.js','server')).toBe('node:path')
    expect(call).not.toHaveBeenCalled()
    expect(resolveVolumeImport('path','/app/main.js','client')).toBe('/app/node_modules/path/index.js')
    expect(call).toHaveBeenCalled()
  })
})

test('the server plugin marks builtins external while keeping client package resolution',async()=>{
  const hook=volumeResolver().resolveId
  if(typeof hook!=='function')throw Error('Expected resolver hook')
  const previous=getNativeSyncFileClient(),volume=Volume.fromJSON({
    '/app/main.js':'','/app/node_modules/path/package.json':'{"main":"index.js"}',
    '/app/node_modules/path/index.js':'export default {}'})
  const session=new NativeTerminalFileSession(volume)
  const call=vi.fn((method:string,args:unknown[])=>session.call(method,args))
  setNativeSyncFileClient({call} as any)
  try{
    const server={environment:{config:{consumer:'server',resolve:{}}}}
    expect(await hook.call(server as never,'path','/app/main.js',{} as never)).toEqual({id:'node:path',external:true})
    expect(await hook.call(server as never,'node:fs/promises','/app/main.js',{} as never)).toEqual({id:'node:fs/promises',external:true})
    expect(call).not.toHaveBeenCalled()
    const client={environment:{config:{consumer:'client',resolve:{}}}}
    expect(await hook.call(client as never,'path','/app/main.js',{} as never)).toBe('/app/node_modules/path/index.js')
  }finally{setNativeSyncFileClient(previous);session.close()}
})

test('directory fallback probes each path once and preserves extension order',()=>{
  liveFiles({'/app/lib/index.js':'export default 1','/app/lib/index.ts':'export default 2'},(_volume,call)=>{
    expect(resolveVolumeImport('./lib','/app/main.js')).toBe('/app/lib/index.js')
    const paths=call.mock.calls.map(([method,args])=>{expect(method).toBe('stat');return args[0]})
    expect(paths).toEqual(['/app/lib','/app/lib.js','/app/lib.mjs','/app/lib.cjs','/app/lib.ts',
      '/app/lib.mts','/app/lib.tsx','/app/lib.jsx','/app/lib.json','/app/lib/index.js'])
  })
})

test('missing modules do not probe the same path twice',()=>{
  liveFiles({'/app/main.js':''},(_volume,call)=>{
    expect(resolveVolumeImport('./missing','/app/main.js')).toBeUndefined()
    const paths=call.mock.calls.map(([,args])=>args[0])
    expect(paths.length).toBe(9);expect(new Set(paths).size).toBe(paths.length)
  })
})

test('each new resolution sees added, removed and replaced files',()=>{
  liveFiles({'/app/main.js':''},(volume,call)=>{
    expect(resolveVolumeImport('./value','/app/main.js')).toBeUndefined()
    volume.writeFileSync('/app/value.ts','export default 1')
    expect(resolveVolumeImport('./value','/app/main.js')).toBe('/app/value.ts')
    volume.unlinkSync('/app/value.ts')
    volume.mkdirSync('/app/value',{recursive:true});volume.writeFileSync('/app/value/index.js','export default 2')
    expect(resolveVolumeImport('./value','/app/main.js')).toBe('/app/value/index.js')
    volume.unlinkSync('/app/value/index.js');volume.rmdirSync('/app/value')
    expect(resolveVolumeImport('./value','/app/main.js')).toBeUndefined()
    expect(call.mock.calls.filter(([,args])=>args[0]==='/app/value')).toHaveLength(4)
  })
})

test('live resolver errors other than missing files still propagate',()=>{
  const previous=getNativeSyncFileClient(),error=Object.assign(Error('permission denied'),{code:'EACCES'})
  const call=vi.fn(()=>{throw error})
  setNativeSyncFileClient({call} as any)
  try{
    expect(()=>resolveVolumeImport('./value.js','/app/main.js')).toThrow(error)
    expect(call).toHaveBeenCalledTimes(1)
  }finally{setNativeSyncFileClient(previous)}
})

test('the live loader uses one stat and reads the current contents',()=>{
  liveFiles({'/app/value.js':'export default 1'},(volume,call)=>{
    const hook=volumeResolver().load
    if(typeof hook!=='function')throw Error('Expected loader hook')
    expect(hook.call({} as never,'/app/value.js',{} as never)).toBe('export default 1')
    expect(call.mock.calls.map(([method])=>method)).toEqual(['stat','open','read','read','close'])
    volume.writeFileSync('/app/value.js','export default 2');call.mockClear()
    expect(hook.call({} as never,'/app/value.js',{} as never)).toBe('export default 2')
    expect(call.mock.calls.map(([method])=>method)).toEqual(['stat','open','read','read','close'])
    volume.unlinkSync('/app/value.js')
    expect(hook.call({} as never,'/app/value.js',{} as never)).toBeUndefined()
  })
})
