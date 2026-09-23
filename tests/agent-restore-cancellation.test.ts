import {describe,expect,it,vi} from 'vitest'
import {AgentSession,type AgentWorkspaceSnapshot} from '../src/sdk/agent-session'

const snapshot:AgentWorkspaceSnapshot={version:1,files:{'/restored.txt':{base64:btoa('restored')}}}
const setup=()=>{
  let files:Record<string,Uint8Array>={'/original.txt':new TextEncoder().encode('original')}
  const restore=vi.fn(async(value:{files:Record<string,Uint8Array>})=>{files=value.files})
  const writeFile=vi.fn(async()=>{})
  const session=new AgentSession({}, {kernel:{restore,writeFile} as never,telemetry:{capacity:16}})
  return {session,restore,writeFile,files:()=>files}
}

describe('AgentSession restore cancellation before dispatch',()=>{
  it('does not mutate the workspace when already aborted',async()=>{
    const state=setup(),controller=new AbortController(),reason=Error('cancelled restore')
    const before=state.files()
    controller.abort(reason)
    await expect(state.session.restore({snapshot},controller.signal)).rejects.toBe(reason)
    expect(state.restore).not.toHaveBeenCalled()
    expect(state.files()).toBe(before)
    expect(state.session.telemetry?.events()).toEqual([])
  })

  it('checks cancellation before reading or decoding snapshot data',async()=>{
    const state=setup(),controller=new AbortController(),reason=Error('cancelled before decode')
    const read=vi.fn(()=>{throw Error('snapshot must not be read')})
    const input={get snapshot():AgentWorkspaceSnapshot{return read()}}
    controller.abort(reason)
    await expect(state.session.restore(input,controller.signal)).rejects.toBe(reason)
    expect(read).not.toHaveBeenCalled()
    expect(state.restore).not.toHaveBeenCalled()
  })

  it('does not dispatch a queued restore cancelled before its turn, and keeps the queue usable',async()=>{
    const state=setup(),controller=new AbortController(),reason=Error('cancelled while queued')
    let finish!:()=>void
    const pending=new Promise<void>(resolve=>{finish=resolve})
    state.writeFile.mockImplementationOnce(()=>pending)
    const write=state.session.write({path:'/first.txt',text:'first'})
    await Promise.resolve()
    expect(state.writeFile).toHaveBeenCalledOnce()
    const restore=state.session.restore({snapshot},controller.signal)
    const rejection=expect(restore).rejects.toBe(reason)
    controller.abort(reason)
    finish()
    await write
    await rejection
    expect(state.restore).not.toHaveBeenCalled()
    expect(Object.keys(state.files())).toEqual(['/original.txt'])
    await expect(state.session.restore({snapshot})).resolves.toEqual({restored:true})
    expect(state.restore).toHaveBeenCalledOnce()
    expect(new TextDecoder().decode(state.files()['/restored.txt'])).toBe('restored')
    expect(state.session.telemetry?.events().filter(event=>event.type==='snapshot.restore')).toHaveLength(1)
  })

  it('keeps decoding and kernel errors unchanged for active restores',async()=>{
    const state=setup(),controller=new AbortController()
    await expect(state.session.restore({snapshot:{...snapshot,files:{'/bad':{base64:'!'}}}},controller.signal)).rejects.toMatchObject({name:'InvalidCharacterError'})
    expect(state.restore).not.toHaveBeenCalled()
    const reason=Error('restore rejected')
    state.restore.mockRejectedValueOnce(reason)
    await expect(state.session.restore({snapshot},controller.signal)).rejects.toBe(reason)
    expect(state.session.telemetry?.events()).toEqual([])
  })
})
