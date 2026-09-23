import {afterEach,describe,expect,it,vi} from 'vitest'
import {EsbuildSessionMonitor} from '../src/compiler/esbuild-session-monitor'

const u32=(n:number)=>[n&255,n>>>8&255,n>>>16&255,n>>>24&255]
const string=(s:string)=>{const bytes=[...new TextEncoder().encode(s)];return [...u32(bytes.length),...bytes]}
const frame=(body:number[])=>new Uint8Array([...u32(body.length),...body])
const packet=(id:number,request:boolean,command?:string)=>frame([...u32(id*2+(request?0:1)),6,...u32(command?1:0),...(command?[...string('command'),3,...string(command)]:[])])
const version=()=>frame([...new TextEncoder().encode('0.28.2')])
function setup(){
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']})
  const error=vi.fn()
  const monitor=new EsbuildSessionMonitor({startupMs:100,requestMs:50,maxPacketBytes:1024,maxPending:4},error)
  return {monitor,error}
}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers()})
describe('esbuild session deadlines',()=>{
  it('accepts split handshake and packets, coalesced responses, and unlimited idle time',()=>{
    const {monitor,error}=setup()
    for(const byte of version())monitor.feedOutput(new Uint8Array([byte]))
    vi.advanceTimersByTime(500)
    for(const byte of packet(1,true,'build'))monitor.feedInput(new Uint8Array([byte]))
    monitor.feedInput(packet(2,true,'transform'))
    monitor.feedOutput(new Uint8Array([...packet(1,false),...packet(2,false)]))
    vi.advanceTimersByTime(500)
    expect(error).not.toHaveBeenCalled();monitor.close()
  })
  it('keeps the original request deadline across plugin callbacks',()=>{
    const {monitor,error}=setup();monitor.feedOutput(version())
    monitor.feedInput(packet(1,true,'build'))
    vi.advanceTimersByTime(30)
    monitor.feedOutput(packet(1,true,'on-load'))
    monitor.feedInput(packet(1,false))
    vi.advanceTimersByTime(20)
    expect(error).toHaveBeenCalledTimes(1)
  })
  it('accounts for service pings separately and supports context rebuild and disposal',()=>{
    const {monitor,error}=setup();monitor.feedOutput(version())
    for(const command of ['build','rebuild','dispose']){
      monitor.feedInput(packet(0,true,command))
      monitor.feedOutput(packet(0,true,'ping'));monitor.feedInput(packet(0,false))
      monitor.feedOutput(packet(0,false))
    }
    vi.advanceTimersByTime(500);expect(error).not.toHaveBeenCalled();monitor.close()
  })
  it('times out startup and partial frames from their first byte',()=>{
    const first=setup();vi.advanceTimersByTime(100);expect(first.error).toHaveBeenCalledTimes(1)
    const second=setup();second.monitor.feedOutput(version())
    second.monitor.feedInput(packet(0,true,'build').subarray(0,1))
    vi.advanceTimersByTime(50);expect(second.error).toHaveBeenCalledTimes(1)
  })
  it('does not renew a request deadline when a response arrives in fragments',()=>{
    const {monitor,error}=setup();monitor.feedOutput(version());monitor.feedInput(packet(0,true,'transform'))
    vi.advanceTimersByTime(40);monitor.feedOutput(packet(0,false).subarray(0,2))
    vi.advanceTimersByTime(10);expect(error).toHaveBeenCalledTimes(1)
  })
  it('rejects an overdue response even before the timer callback runs',()=>{
    const {monitor,error}=setup();monitor.feedOutput(version());monitor.feedInput(packet(0,true,'transform'))
    // Simulate an owner event loop occupied past the deadline with its timer queued.
    vi.spyOn(performance,'now').mockReturnValue(51)
    monitor.feedOutput(packet(0,false));expect(error).toHaveBeenCalledTimes(1)
  })
  it.each(['watch','serve'])('reports unsupported %s instead of leaving autonomous builds unaccounted',command=>{
    const {monitor,error}=setup();monitor.feedOutput(version());monitor.feedInput(packet(0,true,command))
    expect(error.mock.calls[0][0].message).toContain('unsupported')
  })
  it('bounds packet storage and outstanding requests',()=>{
    const first=setup();first.monitor.feedInput(new Uint8Array(u32(1025)));expect(first.error).toHaveBeenCalledTimes(1)
    const second=setup();second.monitor.feedOutput(version())
    for(let id=0;id<5;id++)second.monitor.feedInput(packet(id,true,'transform'))
    expect(second.error.mock.calls[0][0].message).toContain('pending')
  })
  it('rejects a mismatched service version and cancels timers on close',()=>{
    const first=setup();first.monitor.feedOutput(frame([...new TextEncoder().encode('0.27.0')]));expect(first.error).toHaveBeenCalledTimes(1)
    const second=setup();second.monitor.close();vi.advanceTimersByTime(1000);expect(second.error).not.toHaveBeenCalled()
  })
})
