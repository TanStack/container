// The browser binding must initialize with browser globals before the Vite
// environment installs its Node-compatible process facade.
import {bootstrapNativeFilesystem} from './filesystem-bootstrap'
import {installCompilerBootstrapReporter} from './compiler-bootstrap-progress.mjs'
const bootstrapProgress=(phase:string)=>self.postMessage({type:'native-dev-progress',phase,elapsedMs:performance.now()})
bootstrapProgress('bootstrap-entered')
await bootstrapNativeFilesystem()
bootstrapProgress('filesystem-connected')
if(!new URL(self.location.href).searchParams.has('native-typecheck')){
  bootstrapProgress('rolldown-loading')
  const releaseCompilerReporter=installCompilerBootstrapReporter(bootstrapProgress)
  try{await import('@rolldown/browser')}
  catch(error){
    const {wasmBootstrapDiagnostics}=await import('./wasm-bootstrap-diagnostics')
    console.error('NATIVE_WASM_BOOTSTRAP_DIAGNOSTIC',JSON.stringify(await wasmBootstrapDiagnostics()))
    throw error
  }
  finally{releaseCompilerReporter()}
  bootstrapProgress('rolldown-loaded')
}
;(globalThis as typeof globalThis & {__nativeVite8?:boolean}).__nativeVite8=true
const { installNodeTimerHandles } = await import('../vite-browser/node-timers')
installNodeTimerHandles()
bootstrapProgress('timer-handles-installed')
const {installNativeAsyncContext}=await import('./async-context')
installNativeAsyncContext()
bootstrapProgress('async-context-installed')
await import('./dev-server.worker')
