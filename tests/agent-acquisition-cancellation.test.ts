import {describe,it,expect,vi} from 'vitest'
import {AgentSession} from '../src/sdk/agent-session'

const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}

describe('AgentSession resource acquisition cancellation',()=>{
  it('does not dispatch a queued mutation after the session closes',async()=>{
    const blocked=deferred<void>(),writeFile=vi.fn(async()=>{}),close=vi.fn()
    const session=new AgentSession({}, {kernel:{
      openFileSession:async()=>({call:async()=>blocked.promise,close:async()=>{}}),
      writeFile,close,shutdown:Promise.resolve(),
    } as never})
    const active=session.mkdir({path:'/first'})
    await flush()
    const queued=session.write({path:'/queued',text:'must not be written'}).catch(error=>error)
    await session.close()
    blocked.resolve();await active
    expect(await queued).toEqual(expect.objectContaining({message:'Agent session closed'}))
    expect(writeFile).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
  it('rejects and disposes an active run when cancellation transport fails',async()=>{
    const next=deferred<any>(),failure=Error('Cancellation transport failed')
    const process={next:vi.fn(()=>next.promise),kill:vi.fn(async()=>{throw failure}),dispose:vi.fn(async()=>{}),wait:vi.fn()}
    const session=new AgentSession({}, {kernel:{spawn:async()=>process} as never})
    const controller=new AbortController()
    const result=session.run({command:'node'},controller.signal).catch(error=>error)
    await flush();expect(process.next).toHaveBeenCalledOnce()
    controller.abort()
    expect(await result).toBe(failure)
    expect(process.dispose).toHaveBeenCalledOnce()
    expect(process.wait).not.toHaveBeenCalled()
    next.resolve({type:'stdout',bytes:new TextEncoder().encode('late output')})
    await flush()
    expect(process.next).toHaveBeenCalledOnce()
    expect(process.wait).not.toHaveBeenCalled()
    expect(process.dispose).toHaveBeenCalledOnce()
  },1000)
  it('waits for the delayed file handle and its close before allowing the next mutation',async()=>{
    const opened=deferred<any>(),closed=deferred<void>(),call=vi.fn(),close=vi.fn(()=>closed.promise),writeFile=vi.fn(async()=>{})
    const openFileSession=vi.fn(()=>opened.promise),session=new AgentSession({}, {kernel:{openFileSession,writeFile} as never})
    const controller=new AbortController(),reason=Error('stop mkdir')
    let settled=false
    const result=session.mkdir({path:'/first'},controller.signal).catch(error=>{settled=true;return error})
    await flush();controller.abort(reason)
    const next=session.write({path:'/second',text:'ok'})
    await flush();expect(settled).toBe(false);expect(writeFile).not.toHaveBeenCalled()
    opened.resolve({call,close});await flush()
    expect(call).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false);expect(writeFile).not.toHaveBeenCalled()
    closed.resolve();expect(await result).toBe(reason);await next
    expect(writeFile).toHaveBeenCalledTimes(1)
  })
  it('kills and disposes a process acquired after cancellation before rejecting',async()=>{
    const opened=deferred<any>(),killed=deferred<boolean>(),disposed=deferred<void>()
    const process={kill:vi.fn(()=>killed.promise),dispose:vi.fn(()=>disposed.promise),next:vi.fn(),wait:vi.fn()}
    const session=new AgentSession({}, {kernel:{spawn:()=>opened.promise} as never}),controller=new AbortController(),reason=Error('stop run')
    let settled=false
    const result=session.run({command:'node'},controller.signal).catch(error=>{settled=true;return error})
    controller.abort(reason);await flush();expect(settled).toBe(false)
    opened.resolve(process);await flush()
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');expect(process.dispose).not.toHaveBeenCalled()
    killed.resolve(true);await flush();expect(process.dispose).toHaveBeenCalledTimes(1);expect(settled).toBe(false)
    disposed.resolve();expect(await result).toBe(reason)
    expect(process.next).not.toHaveBeenCalled();expect(process.wait).not.toHaveBeenCalled()
  })
  it('does not start either acquisition for a pre-aborted signal',async()=>{
    const openFileSession=vi.fn(),spawn=vi.fn(),session=new AgentSession({}, {kernel:{openFileSession,spawn} as never})
    const controller=new AbortController(),reason=Error('already stopped');controller.abort(reason)
    await expect(session.list({},controller.signal)).rejects.toBe(reason)
    await expect(session.run({command:'node'},controller.signal)).rejects.toBe(reason)
    expect(openFileSession).not.toHaveBeenCalled();expect(spawn).not.toHaveBeenCalled()
  })
  it('preserves the abort reason if delayed acquisition fails',async()=>{
    const opened=deferred<any>(),controller=new AbortController(),reason=Error('cancel')
    const session=new AgentSession({}, {kernel:{spawn:()=>opened.promise} as never})
    const result=session.run({command:'node'},controller.signal).catch(error=>error)
    controller.abort(reason);opened.reject(Error('spawn failed'));expect(await result).toBe(reason)
  })
  it('still disposes after kill fails and preserves the abort reason when cleanup fails',async()=>{
    const opened=deferred<any>(),controller=new AbortController(),reason=Error('cancel')
    const dispose=vi.fn(async()=>{throw Error('dispose failed')})
    const session=new AgentSession({}, {kernel:{spawn:()=>opened.promise} as never})
    const result=session.run({command:'node'},controller.signal).catch(error=>error)
    controller.abort(reason);opened.resolve({kill:async()=>{throw Error('kill failed')},dispose})
    expect(await result).toBe(reason);expect(dispose).toHaveBeenCalledTimes(1)
  })
  it('reports an acquisition failure normally without cancellation',async()=>{
    const reason=Error('open failed'),session=new AgentSession({}, {kernel:{openFileSession:async()=>{throw reason}} as never})
    await expect(session.list()).rejects.toBe(reason)
  })
})
