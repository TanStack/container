import {createShellWorker} from './worker-factories'
import {runMvdanWorkerWithFactory,type MvdanWorkerOptions} from './mvdan-worker-core'

export type {MvdanWorkerOptions} from './mvdan-worker-core'

/** The caller owns file sessions and children, and must close them after settlement. */
export function runMvdanWorker(options:MvdanWorkerOptions):Promise<{code:number;error:string;cwd?:string}>{
  return runMvdanWorkerWithFactory(options,()=>createShellWorker(options.assetBaseURL))
}
