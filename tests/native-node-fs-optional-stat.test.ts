import {afterEach,expect,test,vi} from 'vitest'
import {statSync as nodeStatSync,lstatSync as nodeLstatSync} from 'node:fs'
import {Volume} from 'memfs'
import {getNativeSyncFileClient,setNativeSyncFileClient,statSync,lstatSync,vol} from '../src/vite-browser/node-fs'
import {NativeTerminalFileSession} from '../src/native/terminal-file-session'

afterEach(()=>vol.reset())
function outcome(fn:Function,path:string,options?:unknown){
  try{const value=fn(path,options);return value===undefined?{missing:true}:{file:value.isFile()}}
  catch(error){return {code:(error as {code?:string}).code}}
}
function backend(remote:boolean,check:()=>void){
  const previous=getNativeSyncFileClient(),volume=Volume.fromJSON({'/app/base':'file'}),session=new NativeTerminalFileSession(volume)
  vol.fromJSON({'/app/base':'file'})
  setNativeSyncFileClient(remote?{call:(method:string,args:unknown[])=>session.call(method,args)} as any:undefined)
  try{check()}finally{setNativeSyncFileClient(previous);session.close()}
}

test.each([false,true])('optional stat matches Node through the filesystem adapter, remote=%s',remote=>{
  backend(remote,()=>{
    for(const [nodePath,target] of [['README.md/child','/app/base/child'],['README.md/../missing-optional-stat-control','/app/base/../missing-optional-stat-control']])
      expect(outcome(statSync,target,{throwIfNoEntry:false})).toEqual(outcome(nodeStatSync,nodePath,{throwIfNoEntry:false}))
    expect(outcome(lstatSync,'/app/base/child',{throwIfNoEntry:false})).toEqual(outcome(nodeLstatSync,'README.md/child',{throwIfNoEntry:false}))
    expect(outcome(lstatSync,'/app/missing',{throwIfNoEntry:false})).toEqual({missing:true})
  })
})

test.each([false,true])('required metadata still throws through the filesystem adapter, remote=%s',remote=>{
  backend(remote,()=>{
    for(const fn of [statSync,lstatSync])for(const options of [undefined,{}, {throwIfNoEntry:true}]){
      expect(outcome(fn,'/app/base/child',options)).toEqual({code:'ENOTDIR'})
      expect(outcome(fn,'/app/missing',options)).toEqual({code:'ENOENT'})
    }
  })
})

test('optional adapter metadata keeps unexpected error objects and takes one owner call',()=>{
  const previous=getNativeSyncFileClient()
  try{
    for(const code of ['EACCES','EIO'])for(const fn of [statSync,lstatSync]){
      const error=Object.assign(Error('native failure'),{code}),call=vi.fn(()=>{throw error})
      setNativeSyncFileClient({call} as any)
      expect(()=>fn('/app/value',{throwIfNoEntry:false})).toThrow(error)
      expect(call).toHaveBeenCalledTimes(1)
    }
  }finally{setNativeSyncFileClient(previous)}
})
