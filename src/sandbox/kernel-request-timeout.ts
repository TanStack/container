const defaultRequestTimeoutMs=120_000
const installIdleTimeoutMs=150_000
const installAbsoluteTimeoutMs=300_000

export interface KernelRequestDeadlines {idleMs:number;absoluteMs?:number;progressRenewable?:boolean}

export function kernelRequestDeadlines(method:string,executionTimeoutMs:number):KernelRequestDeadlines{
  if(method==='execute'||method==='processWait')return {idleMs:executionTimeoutMs+30_000}
  if(method==='install')return {idleMs:installIdleTimeoutMs,absoluteMs:installAbsoluteTimeoutMs,progressRenewable:true}
  return {idleMs:defaultRequestTimeoutMs}
}
