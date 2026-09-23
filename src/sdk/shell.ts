import type {WorkerKernel} from '../sandbox/kernel'
import {runMvdanShell,type ShellOptions} from '../sandbox/mvdan-shell'

export type ShellExecutionOptions=ShellOptions
export interface ShellExecutionResult {
  exitCode:number
  stdout:Uint8Array
  stderr:Uint8Array
}

/** Run one shell script in a fresh interpreter backed by the kernel workspace. */
export async function runShell(kernel:WorkerKernel,script:string,options:ShellExecutionOptions={}):Promise<ShellExecutionResult>{
  const result=await runMvdanShell(kernel,script,options)
  return {exitCode:result.code,stdout:result.stdout,stderr:result.stderr}
}
