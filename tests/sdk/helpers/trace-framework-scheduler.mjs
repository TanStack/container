// Applied only to a copied example for a diagnostic run.
export function traceFrameworkScheduler(source){
  const target="child=await session.kernel.spawn('node',['server.mjs'],{cwd:'/project',guestWasm:true,webAPIs:true,lifetime:'session',maxBytes:128*1024*1024,timeoutMs:30000})"
  if(source.split(target).length!==2)throw Error('Unexpected framework scheduler integration site')
  return source.replace(target,`globalThis.__frameworkSchedulerKernel=session.kernel;
    ${target.replace('guestWasm:true','diagnostics:true,guestWasm:true')}`)
}
