export function completeKernelWorkerRequest(method:string,postResult:()=>void,stopHeartbeat:()=>void,closeWorker:()=>void){
  postResult()
  if(method!=='shutdown')return
  stopHeartbeat()
  closeWorker()
}

export interface KernelShutdownProcess {owner:number;pid:number;result:Promise<unknown>}
export interface KernelShutdownCompiler {close():Promise<unknown>}

/** Finish guest finalizers before closing the compiler services they own.
 * Every opened compiler receives a close attempt, even when a sibling failed.
 */
export async function shutdownKernelResources(
  processes:KernelShutdownProcess[],
  kill:(owner:number,pid:number)=>unknown,
  compilerOpenings:Array<Promise<KernelShutdownCompiler>|undefined>,
){
  const failures:unknown[]=[]
  for(const process of processes)try{kill(process.owner,process.pid)}catch(error){failures.push(error)}
  for(const result of await Promise.allSettled(processes.map(process=>process.result)))if(result.status==='rejected')failures.push(result.reason)
  const opened=await Promise.allSettled(compilerOpenings.filter((value):value is Promise<KernelShutdownCompiler>=>Boolean(value)))
  const compilers:KernelShutdownCompiler[]=[]
  for(const result of opened)result.status==='fulfilled'?compilers.push(result.value):failures.push(result.reason)
  for(const result of await Promise.allSettled(compilers.map(compiler=>compiler.close())))if(result.status==='rejected')failures.push(result.reason)
  if(failures.length)throw new AggregateError(failures,'Kernel resource shutdown failed')
}
