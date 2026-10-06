import {afterEach,expect,test,vi} from 'vitest'
import {Volume} from 'memfs'
import {getNativeSyncFileClient,setNativeSyncFileClient,vol} from '../src/vite-browser/node-fs'
import {NativeTerminalFileSession} from '../src/native/terminal-file-session'
import {BrowserCommonJS} from '../src/native/commonjs'

afterEach(()=>vol.reset())
function liveFiles(files:Record<string,string>,check:(volume:Volume,call:ReturnType<typeof vi.fn>,loader:BrowserCommonJS)=>void){
  const previous=getNativeSyncFileClient(),volume=Volume.fromJSON(files),session=new NativeTerminalFileSession(volume)
  const call=vi.fn((method:string,args:unknown[])=>session.call(method,args))
  setNativeSyncFileClient({call} as any)
  try{check(volume,call,new BrowserCommonJS())}finally{setNativeSyncFileClient(previous);session.close()}
}

test('CommonJS exact-file resolution needs one live stat',()=>{
  liveFiles({'/app/value.cjs':'module.exports=1'},(_volume,call,loader)=>{
    expect(loader.resolve('./value.cjs','/app/main.cjs')).toBe('/app/value.cjs')
    expect(call.mock.calls).toEqual([['stat',['/app/value.cjs']]])
  })
})

test('CommonJS extension order is unchanged with one probe per candidate',()=>{
  liveFiles({'/app/value.js':'module.exports=1','/app/value.cjs':'module.exports=2',
    '/app/value.json':'3'},(_volume,call,loader)=>{
    expect(loader.resolve('./value','/app/main.cjs')).toBe('/app/value.js')
    expect(call.mock.calls).toEqual([['stat',['/app/value']],['stat',['/app/value.js']]])
  })
})

test('CommonJS directory fallback probes each path once and prefers index.js',()=>{
  liveFiles({'/app/lib/index.js':'module.exports=1','/app/lib/index.cjs':'module.exports=2'},(_volume,call,loader)=>{
    expect(loader.resolve('./lib','/app/main.cjs')).toBe('/app/lib/index.js')
    expect(call.mock.calls).toEqual(['/app/lib','/app/lib.js','/app/lib.cjs','/app/lib.json','/app/lib/index.js']
      .map(path=>['stat',[path]]))
  })
})

test('CommonJS missing files retain their error and seven ordered probes',()=>{
  liveFiles({'/app/main.cjs':''},(_volume,call,loader)=>{
    expect(()=>loader.resolve('./missing','/app/main.cjs')).toThrow('CommonJS file not found: /app/missing')
    expect(call.mock.calls).toEqual(['/app/missing','/app/missing.js','/app/missing.cjs','/app/missing.json',
      '/app/missing/index.js','/app/missing/index.cjs','/app/missing/index.json'].map(path=>['stat',[path]]))
  })
})

test('CommonJS resolutions see newly added, removed and replaced files without metadata caching',()=>{
  liveFiles({'/app/main.cjs':''},(volume,call,loader)=>{
    expect(()=>loader.resolve('./value','/app/main.cjs')).toThrow('file not found')
    volume.writeFileSync('/app/value.js','module.exports=1')
    expect(loader.resolve('./value','/app/main.cjs')).toBe('/app/value.js')
    volume.unlinkSync('/app/value.js');volume.mkdirSync('/app/value');volume.writeFileSync('/app/value/index.js','module.exports=2')
    expect(loader.resolve('./value','/app/main.cjs')).toBe('/app/value/index.js')
    volume.unlinkSync('/app/value/index.js');volume.rmdirSync('/app/value')
    expect(()=>loader.resolve('./value','/app/main.cjs')).toThrow('file not found')
    expect(call.mock.calls.filter(([,args])=>args[0]==='/app/value')).toHaveLength(4)
  })
})

test('CommonJS live non-missing errors preserve their identity with one probe',()=>{
  const previous=getNativeSyncFileClient(),failure=Object.assign(Error('permission denied'),{code:'EACCES'})
  const call=vi.fn(()=>{throw failure});setNativeSyncFileClient({call} as any)
  try{
    expect(()=>new BrowserCommonJS().resolve('./value.cjs','/app/main.cjs')).toThrow(failure)
    expect(call).toHaveBeenCalledTimes(1)
  }finally{setNativeSyncFileClient(previous)}
})

test('CommonJS extensionless classification uses one live metadata probe',()=>{
  liveFiles({'/app/package.json':'{"type":"commonjs"}','/app/cli':'#!/usr/bin/env node\nmodule.exports=1'},(_volume,call,loader)=>{
    expect(loader.isCommonJS('/app/cli')).toBe(true)
    expect(call.mock.calls.filter(([method,args])=>method==='stat'&&args[0]==='/app/cli')).toHaveLength(1)
    expect(call.mock.calls.map(([method])=>method)).toEqual(['stat','open','read','read','close','stat','open','read','read','close'])
  })
})

test('CommonJS classification still skips non-JavaScript extensions without filesystem probes',()=>{
  liveFiles({'/app/main.cjs':''},(_volume,call,loader)=>{
    expect(loader.isCommonJS('/app/value.json')).toBe(false)
    expect(loader.isCommonJS('/app/value.mjs')).toBe(false)
    expect(loader.isCommonJS('/app/value.cjs')).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })
})

test('CommonJS owned-volume probes follow links and observe dangling or retargeted links',()=>{
  vol.fromJSON({'/app/value.js':'module.exports=1','/app/other.cjs':'module.exports=2'})
  vol.symlinkSync('/app/value.js','/app/alias')
  const loader=new BrowserCommonJS()
  expect(loader.resolve('./alias','/app/main.cjs')).toBe('/app/alias')
  vol.unlinkSync('/app/value.js')
  expect(()=>loader.resolve('./alias','/app/main.cjs')).toThrow('CommonJS file not found: /app/alias')
  vol.unlinkSync('/app/alias');vol.symlinkSync('/app/other.cjs','/app/alias')
  expect(loader.resolve('./alias','/app/main.cjs')).toBe('/app/alias')
})

test('CommonJS owned-volume file-as-parent lookup stays a missing-module failure',()=>{
  vol.fromJSON({'/app/file':'not a directory'})
  expect(()=>new BrowserCommonJS().resolve('./file/child','/app/main.cjs'))
    .toThrow('CommonJS file not found: /app/file/child')
})
