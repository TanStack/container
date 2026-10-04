import assert from 'node:assert/strict'
import test from 'node:test'
import {runInNewContext} from 'node:vm'
import {linuxProcessMemory,linuxMemoryCounters} from '../scripts/linux-owner-memory-observation.mjs'
import {installNativeWorkerLifecycleObservation} from '../scripts/native-worker-lifecycle-observation.mjs'

test('Linux memory metadata keeps bytes, process identity and thread counts distinct',()=>{
  assert.deepEqual(linuxProcessMemory('Name:\tWPEWebProcess\nVmSize:\t80000000 kB\nVmRSS:\t1000 kB\nRssAnon:\t800 kB\nRssFile:\t200 kB\nThreads:\t7\n'),{
    name:'WPEWebProcess',VmRSS:1024000,RssAnon:819200,RssFile:204800,VmSize:81920000000,Threads:7,
  })
  assert.deepEqual(linuxProcessMemory('Name:\tnode\nThreads:\t1\n'),{name:'node',Threads:1})
})

test('Linux memory event parsing preserves OOM evidence and rejects malformed counters',()=>{
  assert.deepEqual(linuxMemoryCounters('low 0\nhigh 0\nmax 42\noom 2\noom_kill 1\n'),{low:0,high:0,max:42,oom:2,oom_kill:1})
  for(const text of ['oom nope','oom -1','oom 2 unexpected'])assert.throws(()=>linuxMemoryCounters(text),/Unexpected/)
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
