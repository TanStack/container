import test from 'node:test'
import assert from 'node:assert/strict'
import {linuxProcessCPU,linuxProcessCPUDelta,readLinuxProcessCPU} from '../scripts/linux-process-cpu-observation.mjs'

const stat=({pid=12,name='MainThread',parent=1,user=120,system=30,start=400,threads=4}={})=>{
  const fields=Array.from({length:21},()=>0)
  Object.assign(fields,{0:parent,10:user,11:system,16:threads,18:start})
  return `${pid} (${name}) S ${fields.join(' ')}\n`
}
test('Linux CPU metadata uses kernel field positions and handles spaces or parentheses in names',()=>{
  assert.deepEqual(linuxProcessCPU(stat({name:'worker (helper) thread'})),
    {pid:12,name:'worker (helper) thread',state:'S',parentPID:1,userTicks:120,systemTicks:30,startTicks:400,threads:4})
})
test('Linux CPU parser rejects incomplete, negative or unsafe counters',()=>{
  for(const value of ['invalid','12 (worker) S 1',stat({user:-1}),stat({start:9007199254740992})])
    assert.throws(()=>linuxProcessCPU(value))
})
test('Linux CPU deltas report elapsed CPU time, not whole-machine percentage',()=>{
  assert.deepEqual(linuxProcessCPUDelta(linuxProcessCPU(stat()),linuxProcessCPU(stat({user:320,system:80})),
    {ticksPerSecond:100,elapsedMs:1000}),{pid:12,cpuMs:2500,cores:2.5,userTicks:200,systemTicks:50})
})
test('reused PIDs, different PIDs and counter resets cannot become CPU samples',()=>{
  for(const row of [{start:401},{pid:13},{user:119},{system:29}])
    assert.equal(linuxProcessCPUDelta(linuxProcessCPU(stat()),linuxProcessCPU(stat(row)),{ticksPerSecond:100,elapsedMs:1000}),undefined)
  for(const options of [{ticksPerSecond:0,elapsedMs:1},{ticksPerSecond:100,elapsedMs:0}])
    assert.throws(()=>linuxProcessCPUDelta(linuxProcessCPU(stat()),linuxProcessCPU(stat()),options))
})
function inputs({maxProcesses=128,missing=false,bad=false}={}){
  const reads=[],links=[]
  return {reads,links,options:{maxProcesses,
    list:async()=>['self','1','2','3','4'],
    link:async path=>{links.push(path);if(missing&&path==='/proc/2/exe')throw Object.assign(Error('gone'),{code:'ENOENT'});
      return path==='/proc/1/exe'?'/usr/bin/bash':path==='/proc/4/exe'?'/browser/WPENetworkProcess':'/browser/chrome'},
    read:async path=>{reads.push(path);if(bad&&path==='/proc/2/stat')throw Object.assign(Error('failed'),{code:'EIO'});
      if(path.startsWith('/proc/'))return stat({pid:Number(path.split('/')[2])})
      if(path.endsWith('/cpu.stat'))return 'usage_usec 100\ncore_sched.force_idle_usec 0\nnr_throttled 2\nthrottled_usec 10\n'
      if(path.endsWith('/memory.current'))return '8192\n'
      if(path.endsWith('/memory.events'))return 'oom 0\noom_kill 0\n'
      throw Error('Unexpected read '+path)},
  }}
}
test('Linux CPU reader selects executable identity, not truncated task names or arguments',async()=>{
  const io=inputs(),result=await readLinuxProcessCPU(io.options)
  assert.deepEqual(result.processes.map(row=>[row.pid,row.executable]),[[2,'chrome'],[3,'chrome'],[4,'WPENetworkProcess']])
  assert.equal(result.cpu.usage_usec,100);assert.equal(result.memoryBytes,8192);assert.equal(result.dropped,0)
  assert.equal(result.cpu['core_sched.force_idle_usec'],0)
  assert.ok(io.reads.every(path=>!path.includes('cmdline')&&!path.includes('environ')))
  assert.ok(!io.reads.includes('/proc/1/stat'))
})
test('Linux CPU reader bounds retained processes and counts overflow',async()=>{
  const result=await readLinuxProcessCPU(inputs({maxProcesses:1}).options)
  assert.equal(result.processes.length,1);assert.equal(result.dropped,2)
  for(const maxProcesses of [0,257,1.5])await assert.rejects(()=>readLinuxProcessCPU(inputs({maxProcesses}).options))
})
test('Linux ARM64 Playwright headless shell is selected by its executable name',async()=>{
  const io=inputs(),original=io.options.link
  io.options.link=async path=>path==='/proc/2/exe'?'/ms-playwright/chromium_headless_shell/chrome-linux/headless_shell':original(path)
  const result=await readLinuxProcessCPU(io.options)
  assert.equal(result.processes.find(row=>row.pid===2)?.executable,'headless_shell')
})
test('Linux CPU reader tolerates exited processes but preserves other read errors',async()=>{
  const result=await readLinuxProcessCPU(inputs({missing:true}).options)
  assert.deepEqual(result.processes.map(row=>row.pid),[3,4])
  await assert.rejects(()=>readLinuxProcessCPU(inputs({bad:true}).options),{code:'EIO'})
})
