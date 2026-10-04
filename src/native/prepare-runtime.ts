import {resolveProjectLock,planProjectInstall} from '../npm/project'
import type {RuntimeLock} from '../npm/types'
import {selectNativeRuntime} from './runtime-selection'
import type {NativeRuntimeCandidate} from './runtime-selection'

/** Resolve a canonical /app workspace before choosing among hosted compiler assets. */
export async function prepareNativeRuntime(
  input:Record<string,string|Uint8Array>,
  candidates:readonly NativeRuntimeCandidate[],
  options:{lock?:RuntimeLock;installedOnly?:boolean;signal?:AbortSignal}={},
){
  options.signal?.throwIfAborted()
  const files=Object.fromEntries(Object.entries(input).map(([path,value])=>[path,typeof value==='string'?value:value.slice()]))
  let lock=options.lock
  const hasCompilerManifest=['vite','rolldown'].some(name=>Object.hasOwn(files,`/app/node_modules/${name}/package.json`))
  const hasProjectLock=['/app/npm-shrinkwrap.json','/app/package-lock.json'].some(path=>Object.hasOwn(files,path))
  if(!lock&&!options.installedOnly&&!hasProjectLock&&!hasCompilerManifest){
    const source=files['/app/package.json']
    if(source===undefined)throw Error('Runtime preparation requires package.json')
    const manifest=typeof source==='string'?source:new TextDecoder().decode(source)
    const resolved=await resolveProjectLock(manifest,options.signal)
    options.signal?.throwIfAborted()
    lock=planProjectInstall(manifest,resolved).lock
    files['/app/package-lock.json']=resolved
  }
  options.signal?.throwIfAborted()
  const candidate=selectNativeRuntime(files,candidates,lock,options.installedOnly)
  return {files,lock,candidate}
}
