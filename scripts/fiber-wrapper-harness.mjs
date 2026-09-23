import {EngineAccess} from '../src/sandbox/engine-access.ts'
import {TaskScheduler} from '../src/sandbox/task-scheduler.ts'
import {ThreadGroupMailbox} from '../src/sandbox/thread-group-mailbox.ts'

export async function runFiberWrapper(engine){
  const runtime=engine.newRuntime(),peerRuntime=engine.newRuntime()
  for(const rt of [runtime,peerRuntime]){rt.setMemoryLimit(32*1024*1024);rt.setMaxStackSize(256*1024);rt.setInterruptHandler(()=>performance.now()>deadline)}
  const deadline=performance.now()+5000
  const context=runtime.newContext(),peer=peerRuntime.newContext()
  const access=new EngineAccess(),scheduler=new TaskScheduler(),mailbox=new ThreadGroupMailbox(4)
  const events=[],loads=[],callbacks=[]
  const check=(condition,label)=>{if(!condition)throw Error(label)}
  const rejects=(operation,label)=>{let rejected=false;try{operation()}catch{rejected=true}check(rejected,label)}
  const unwrap=(ctx,result)=>{if(result.error){const error=ctx.dump(result.error);result.dispose();throw Error(JSON.stringify(error))}return result.value}
  const evaluate=(ctx,source)=>unwrap(ctx,ctx.evalCode(source))
  let scheduled
  const schedule=context.newFunction('schedule',callback=>{
    const owned=callback.dup();callbacks.push(owned)
    scheduled=new Promise(resolve=>setTimeout(()=>{
      access.enqueue(()=>{const result=context.callFunction(owned,context.undefined);unwrap(context,result).dispose()})
      resolve()
    },0))
  })
  context.setProp(context.global,'schedule',schedule);schedule.dispose()
  const record=context.newFunction('record',value=>{events.push(context.getString(value))})
  context.setProp(context.global,'record',record);record.dispose()
  const initializer=evaluate(context,'park=>{globalThis.park=park}')
  unwrap(context,context.initializeFiber(initializer)).dispose();initializer.dispose()
  const loader=name=>{
    loads.push(name)
    if(name==='dep')return 'export const offset=1'
    if(name==='parent')return "import {offset} from 'dep';export function run(){schedule(()=>{record('timer');Promise.resolve().then(()=>record('microtask'))});record('before');const value=park();record('after');return value+offset}"
    if(name==='peer')return 'export function run(){return 6*7}'
    throw Error('Unknown fixture module '+name)
  }
  runtime.setModuleLoader(loader);peerRuntime.setModuleLoader(loader)
  try{
    unwrap(context,await context.evalCodeAsync("import {run} from 'parent';globalThis.run=run",'parent-entry.mjs',{type:'module'})).dispose()
    unwrap(peer,await peer.evalCodeAsync("import {run} from 'peer';globalThis.run=run",'peer-entry.mjs',{type:'module'})).dispose()
    const fn=context.getProp(context.global,'run'),peerFn=peer.getProp(peer.global,'run')
    const fiber=context.startFiberCall(fn),peerFiber=peer.startFiberCall(peerFn)
    rejects(()=>context.startFiberCall(fn),'One outstanding fiber per runtime')
    rejects(()=>context.dispose(),'Live fiber retains wrapper context')
    rejects(()=>runtime.dispose(),'Live fiber retains wrapper runtime')
    fn.dispose();peerFn.dispose()
    const identity=mailbox.createTask(1)
    const result=await access.run(async()=>{
      check(fiber.step()===1,'Parent parks through normal wrapper')
      const request=mailbox.park(identity)
      check(peerFiber.step()===2,'Separate runtime progresses')
      const peerResult=unwrap(peer,peerFiber.takeResult())
      check(peer.getNumber(peerResult)===42,'Peer result');peerResult.dispose();peerFiber.dispose()
      await scheduled
      check(events.join(',')==='before'&&access.pending===1,'Parent timer stays queued while suspended')
      const waiting=scheduler.wait(false,1000)
      setTimeout(()=>{mailbox.deliver(request,{ok:true,value:42});scheduler.wake()},1)
      await waiting
      const completion=mailbox.consume(identity)
      check(completion?.kind==='result'&&completion.result.ok,'Mailbox result')
      check(fiber.deliver(completion.result.value),'Fiber accepts result')
      check(fiber.step()===2,'Parent resumes')
      const result=fiber.takeResult();fiber.dispose()
      mailbox.acknowledgeUnwind(request);mailbox.disposeTask(identity)
      return result
    })
    const value=unwrap(context,result);check(context.getNumber(value)===43,'Module closure preserved');value.dispose()
    check(events.join(',')==='before,after','Timer not reentered into parked call')
    access.drain(1)
    while(runtime.hasPendingJob()){const jobs=await runtime.executePendingJobs();if(jobs.error){const error=context.dump(jobs.error);jobs.dispose();throw Error(JSON.stringify(error))}jobs.dispose()}
    check(events.join(',')==='before,after,timer,microtask','Timer and microtask order')
    check(loads.includes('parent')&&loads.includes('dep')&&loads.includes('peer'),'Normal module loader used')
    const cancelledFunction=evaluate(context,"()=>{park();record('unexpected')}"),cancelled=context.startFiberCall(cancelledFunction)
    cancelledFunction.dispose()
    check(cancelled.step()===1,'Cancellation parks')
    const cancelledIdentity=mailbox.createTask(1),cancelledRequest=mailbox.park(cancelledIdentity)
    mailbox.cancel(cancelledIdentity,{message:'stop'})
    check(mailbox.consume(cancelledIdentity)?.kind==='cancelled','Cancellation consumed')
    check(cancelled.cancel()&&cancelled.step()===2,'Cancelled stack unwinds')
    const cancelledResult=cancelled.takeResult()
    check(Boolean(cancelledResult.error),'Cancellation is a guest error')
    check(context.dump(cancelledResult.error).message.includes('cancelled'),'Cancellation message')
    cancelledResult.dispose();cancelled.dispose()
    mailbox.acknowledgeUnwind(cancelledRequest);mailbox.disposeTask(cancelledIdentity)
    await new Promise(resolve=>setTimeout(resolve,1))
    check(!mailbox.deliver(cancelledRequest,{ok:true,value:99}),'Late cancellation result rejected')
    let interrupts=0
    peerRuntime.setInterruptHandler(()=>++interrupts>10)
    const loopFunction=evaluate(peer,'()=>{while(true){}}'),limited=peer.startFiberCall(loopFunction)
    loopFunction.dispose();check(limited.step()===2,'Peer budget stops execution')
    const limitedResult=limited.takeResult();check(Boolean(limitedResult.error)&&interrupts>10,'Budget returns guest error')
    limitedResult.dispose();limited.dispose()
    const recovered=evaluate(context,'6*7');check(context.getNumber(recovered)===42,'Parent survives peer budget and cancellation');recovered.dispose()
    const errorFunction=evaluate(context,"()=>{throw Error('original fiber error')}"),errored=context.startFiberCall(errorFunction)
    errorFunction.dispose();check(errored.step()===2,'Error fiber finishes')
    const unrelated=context.evalCode("throw Error('later error')");check(Boolean(unrelated.error),'Later error control');unrelated.dispose()
    const original=errored.takeResult();check(Boolean(original.error)&&context.dump(original.error).message==='original fiber error','Fiber owns original exception');original.dispose();errored.dispose()
    let nestedError
    const nested=context.newFunction('nested',()=>{
      const result=context.evalCode('park()')
      nestedError=result.error?context.dump(result.error):undefined
      result.dispose();return context.newNumber(7)
    })
    context.setProp(context.global,'nested',nested);nested.dispose()
    const reentryFunction=evaluate(context,'()=>nested()'),reentry=context.startFiberCall(reentryFunction)
    reentryFunction.dispose();check(reentry.step()===2,'Nested host callback never parks')
    const reentryResult=unwrap(context,reentry.takeResult());check(context.getNumber(reentryResult)===7&&Boolean(nestedError),'Nested park rejected without corrupting caller');reentryResult.dispose();reentry.dispose()
    check(events.join(',')==='before,after,timer,microtask','Cancelled continuation did not run')
    return {moduleLoader:true,peerResult:42,parentResult:43,events,cancellation:true,lateCompletion:true,independentBudget:true,recovered:42,runtimeExclusion:true,lifetimeGuards:true,exceptionOwnership:true,nestedParkRejected:true,pending:mailbox.pending}
  }finally{
    for(const callback of callbacks)callback.dispose()
    scheduler.close();access.close();context.dispose();peer.dispose();runtime.dispose();peerRuntime.dispose()
  }
}
