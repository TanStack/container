import {runtimeAssetURL} from '../sandbox/runtime-assets'

// These workers and their dependency graph are deployed together, not rebundled
// by the consumer application. The base is trusted owner configuration.
function createWorker(name:string,assetBaseURL?:string){
  if(!assetBaseURL)throw Error('Packaged workers require an owner asset base URL')
  return new Worker(runtimeAssetURL('workers/'+name+'.js',assetBaseURL),{type:'module'})
}
export const createKernelWorker=(base?:string)=>createWorker('kernel',base)
export const createCompilerWorker=(base?:string)=>createWorker('compiler',base)
export const createShellWorker=(base?:string)=>createWorker('mvdan-shell',base)
export const createBrowserCompilerWorker=(base?:string)=>createWorker('browser-compiler',base)
