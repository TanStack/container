import {WorkerKernel as Kernel} from '../sandbox/kernel'
import type {KernelOwnerOptions} from '../sandbox/kernel-limits'

/** Experimental SDK. Host these trusted assets on the application's origin. */
export class WorkerKernel extends Kernel {
  constructor(files:Record<string,string|Uint8Array>={},options:KernelOwnerOptions={}){
    super(files,{...options,assetBaseURL:options.assetBaseURL??new URL('./runtime/',import.meta.url).href})
  }
}
