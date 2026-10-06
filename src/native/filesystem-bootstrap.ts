import './disposal-symbols.mjs'
import {fs as constructors} from 'memfs'
import {createFsProxy} from 'tanstack:filesystem-codec-124'
import {createNativeFilesystemClientApi} from './filesystem-client-api.mjs'
import {createWasiFilesystemEndpoint} from './wasi-filesystem-service.mjs'
import {connectWasiFilesystemPort} from './wasi-fs-transport.mjs'
import {installNativeFilesystemProvider} from './filesystem-provider.mjs'
import {installNativeFilesystemConnection,receiveNativeFilesystemBootstrap} from './filesystem-worker-link.mjs'
import {keepNodeCommandAlive} from '../vite-browser/node-timers'
import {NativeAsyncResource} from './async-context'

export async function bootstrapNativeFilesystem(){
  const connection=await receiveNativeFilesystemBootstrap()
  installNativeFilesystemConnection(connection)
  const endpoint=createWasiFilesystemEndpoint(connection.control,connection.id,{codec:'1.2.4'})
  connectWasiFilesystemPort(endpoint.port)
  const raw=createFsProxy(constructors)
  installNativeFilesystemProvider(createNativeFilesystemClientApi(raw,constructors,endpoint.port,{
    cwd:()=> (globalThis as typeof globalThis & {process?:{cwd?:()=>string}}).process?.cwd?.()??'/app',
    createAsyncResource:name=>new NativeAsyncResource(name),keepAlive:keepNodeCommandAlive,
  }))
  // Every worker owns a compiler filesystem, even when its first compiler is
  // loaded by a command or thread rather than Rolldown. Import only after the
  // remote provider is installed, so node:fs cannot create a local fallback.
  await import('./compiler-filesystem')
}
