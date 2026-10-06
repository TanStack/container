import assert from 'node:assert/strict'
import test from 'node:test'
import {runInNewContext} from 'node:vm'
import {linuxProcessMemory,linuxMemoryCounters,readLinuxOwnerMemory} from '../scripts/linux-owner-memory-observation.mjs'
import {installNativeWorkerLifecycleObservation} from '../scripts/native-worker-lifecycle-observation.mjs'

test('Linux memory metadata keeps bytes, process identity and thread counts distinct',()=>{
  assert.deepEqual(linuxProcessMemory('Name:\tWPEWebProcess\nVmSize:\t80000000 kB\nVmRSS:\t1000 kB\nRssAnon:\t800 kB\nRssFile:\t200 kB\nThreads:\t7\n'),{
    name:'WPEWebProcess',VmRSS:1024000,RssAnon:819200,RssFile:204800,VmSize:81920000000,Threads:7,
  })
  assert.deepEqual(linuxProcessMemory('Name:\tnode\nThreads:\t1\n'),{name:'node',Threads:1})
})

test('Linux process names keep spaces instead of losing the rest of the name',()=>{
  assert.deepEqual(linuxProcessMemory('Name:\tWPE Web Process\nThreads:\t3\n'),{name:'WPE Web Process',Threads:3})
})

const memoryFixture=()=>{
  const files=new Map([
    ['/proc/11/status','Name:\tMainThread\nVmRSS:\t20 kB\nThreads:\t2\n'],
    ['/proc/12/status','Name:\tWPENetworkProce\nVmRSS:\t30 kB\n'],
    ['/proc/13/status','Name:\tnode\nVmRSS:\t40 kB\n'],
    ['/proc/14/status','Name:\tWPE Web Process\nVmRSS:\t50 kB\n'],
    ['/sys/fs/cgroup/memory.current','1000\n'],['/sys/fs/cgroup/memory.peak','2000\n'],
    ['/sys/fs/cgroup/memory.events','max 0\noom 0\noom_kill 0\n'],
    ['/sys/fs/cgroup/memory.stat','anon 600\nfile 400\n'],
  ])
  const links=new Map([
    ['/proc/11/exe','/opt/node/bin/node'],['/proc/12/exe','/ms-playwright/WPENetworkProcess'],
    ['/proc/13/exe','/opt/other-process'],['/proc/14/exe','/ms-playwright/WPEWebProcess'],
  ])
  const read=async path=>{assert.ok(files.has(path),'Unexpected read: '+path);return files.get(path)}
  const link=async path=>{assert.ok(links.has(path),'Unexpected readlink: '+path);return links.get(path)}
  const list=async path=>{assert.equal(path,'/proc');return ['13','self','14','11','12']}
  return {read,link,list}
}

test('Linux memory selection uses executable identity, not renamed or truncated task names',async()=>{
  const result=await readLinuxOwnerMemory(memoryFixture())
  assert.deepEqual(result.processes,[
    {pid:11,executable:'/opt/node/bin/node',name:'MainThread',VmRSS:20480,Threads:2},
    {pid:12,executable:'/ms-playwright/WPENetworkProcess',name:'WPENetworkProce',VmRSS:30720},
    {pid:14,executable:'/ms-playwright/WPEWebProcess',name:'WPE Web Process',VmRSS:51200},
  ])
  assert.equal(result.currentBytes,1000);assert.equal(result.peakBytes,2000)
  assert.deepEqual(result.events,{max:0,oom:0,oom_kill:0})
  assert.deepEqual(result.stats,{anon:600,file:400})
})

test('a process exiting during executable lookup is skipped, permission errors are not',async()=>{
  for(const code of ['ENOENT','ESRCH']){
    const fixture=memoryFixture(),original=fixture.link
    fixture.link=async path=>{if(path==='/proc/11/exe')throw Object.assign(Error('process exited'),{code});return original(path)}
    const result=await readLinuxOwnerMemory(fixture)
    assert.deepEqual(result.processes.map(row=>row.pid),[12,14])
  }
  const fixture=memoryFixture()
  fixture.link=async()=>{throw Object.assign(Error('permission denied'),{code:'EACCES'})}
  await assert.rejects(readLinuxOwnerMemory(fixture),{code:'EACCES'})
})

test('Linux memory event parsing preserves OOM evidence and rejects malformed counters',()=>{
  assert.deepEqual(linuxMemoryCounters('low 0\nhigh 0\nmax 42\noom 2\noom_kill 1\n'),{low:0,high:0,max:42,oom:2,oom_kill:1})
  for(const text of ['oom nope','oom -1','oom 2 unexpected'])assert.throws(()=>linuxMemoryCounters(text),/Unexpected/)
})

test('Linux flat counters preserve namespaced CPU fields without accepting malformed keys',()=>{
  assert.deepEqual(linuxMemoryCounters('usage_usec 30647\ncore_sched.force_idle_usec 0\nnr_throttled 0\n'),
    {usage_usec:30647,'core_sched.force_idle_usec':0,nr_throttled:0})
  for(const text of ['.counter 0','counter. 0','counter..field 0','counter/field 0',
    'usage_usec 9007199254740992','oom 1\noom 2'])assert.throws(()=>linuxMemoryCounters(text))
})

test('worker observation preserves constructor, arguments and termination, without strong worker references',()=>{
  const rows=[],terminations=[]
  class Worker{
    constructor(...args){this.args=args}
    terminate(...args){terminations.push({worker:this,args});return 42}
  }
  const realm={Worker,location:{pathname:'/owner.html',href:'https://owner.test/owner.html'},
    console:{info:text=>rows.push(JSON.parse(text.slice('NATIVE_WORKER_LIFECYCLE '.length)))},performance:{now:()=>1},URL}
  runInNewContext('('+installNativeWorkerLifecycleObservation.toString()+')()',realm)
  const options={type:'module'},worker=new realm.Worker('/engine.js',options)
  assert.ok(worker instanceof Worker)
  assert.ok(worker instanceof realm.Worker)
  assert.equal(worker.args[1],options)
  assert.equal(rows[0].path,'/engine.js')
  assert.equal(rows[0].live,1)
  assert.equal(worker.terminate('argument'),42)
  assert.equal(terminations[0].worker,worker)
  assert.deepEqual(terminations[0].args,['argument'])
  assert.equal(rows[1].kind,'termination-requested')
  assert.equal(rows[1].live,0)
  worker.terminate()
  assert.equal(terminations.length,2)
  assert.equal(rows.length,2)
  assert.doesNotMatch(installNativeWorkerLifecycleObservation.toString(),/active\.set\(id,worker\)/)
})

test('observer does not alter unrelated pages or swallow native termination errors',()=>{
  class Worker{terminate(){throw Error('native error')}}
  const other={Worker,location:{pathname:'/other.html'}}
  runInNewContext('('+installNativeWorkerLifecycleObservation.toString()+')()',other)
  assert.equal(other.Worker,Worker)
  const realm={Worker,location:{pathname:'/owner.html',href:'https://owner.test/owner.html'},
    console:{info(){}},performance:{now:()=>0},URL}
  runInNewContext('('+installNativeWorkerLifecycleObservation.toString()+')()',realm)
  assert.throws(()=>new realm.Worker('/engine.js').terminate(),/native error/)
})
