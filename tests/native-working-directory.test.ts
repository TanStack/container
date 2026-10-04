import {test,expect} from 'vitest'
import {Volume} from 'memfs'
import {resolveWorkingDirectory,assertCanChangeDirectory} from '../src/native/working-directory'
import {NativeTerminalFileSession} from '../src/native/terminal-file-session'
import fs,{getNativeSyncFileClient,setNativeSyncFileClient} from '../src/vite-browser/node-fs'

test('worker threads cannot change the process directory',()=>{
  expect(()=>assertCanChangeDirectory(true)).toThrow(expect.objectContaining({code:'ERR_WORKER_UNSUPPORTED_OPERATION'}))
  expect(()=>assertCanChangeDirectory(false)).not.toThrow()
})

test('working directory sees live project and scratch directories',()=>{
  const previous=getNativeSyncFileClient(),volume=Volume.fromJSON({'/app/main.js':''})
  const session=new NativeTerminalFileSession(volume)
  setNativeSyncFileClient({call:(method:string,args:unknown[])=>session.call(method,args)} as any)
  try{
    volume.mkdirSync('/tmp/late')
    volume.mkdirSync('/app/late')
    volume.mkdirSync('/outside')
    volume.symlinkSync('/outside','/tmp/escape')
    expect(resolveWorkingDirectory('/app','/tmp/late',fs)).toBe('/tmp/late')
    expect(resolveWorkingDirectory('/tmp','late',fs)).toBe('/tmp/late')
    expect(resolveWorkingDirectory('/tmp/late','../../app/late',fs)).toBe('/app/late')
    expect(()=>resolveWorkingDirectory('/app','main.js',fs)).toThrow(expect.objectContaining({code:'ENOTDIR'}))
    expect(()=>resolveWorkingDirectory('/app','missing',fs)).toThrow(expect.objectContaining({code:'ENOENT'}))
    for(const target of ['/','/etc','/tmp-other','../../etc'])
      expect(()=>resolveWorkingDirectory('/app',target,fs)).toThrow(expect.objectContaining({code:'ERR_OUTSIDE_CONTAINER_PATH'}))
    expect(()=>resolveWorkingDirectory('/app','/tmp/escape',fs)).toThrow()
  }finally{setNativeSyncFileClient(previous);session.close()}
})
