import {afterEach,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({worker:undefined as any}))
vi.mock('../src/sandbox/worker-factories',()=>({createKernelWorker:()=>{
  const worker={onmessage:null as any,onerror:null,postMessage(message:any){if(message.method==='init')queueMicrotask(()=>worker.onmessage({data:{id:message.id,type:'result',value:null}}))},terminate:vi.fn()}
  state.worker=worker;return worker
}}))
import {WorkerKernel} from '../src/sandbox/kernel'
afterEach(()=>vi.unstubAllGlobals())
it('retains the latest 512 guest samples with separate bounded error and drop metadata',async()=>{
  vi.stubGlobal('location',{href:'http://localhost/'})
  const kernel=new WorkerKernel();await Promise.resolve()
  try{
    const sample={time:1,offset:0,bytecodeLength:1,flags:0,functionName:'fn',filename:'app.js',sequence:1}
    state.worker.onmessage({data:{type:'guest-samples',value:{pid:7,samples:[sample],dropped:2}}})
    sample.functionName='mutated'
    expect(kernel.guestSamples[0].functionName).toBe('fn')
    for(let sequence=2;sequence<=520;sequence++)state.worker.onmessage({data:{type:'guest-samples',value:{pid:8,samples:[{...sample,sequence}],dropped:0}}})
    expect(kernel.guestSamples).toHaveLength(512)
    expect(kernel.guestSamples[0]).toMatchObject({pid:8,sequence:9})
    expect(kernel.guestSamples.at(-1)?.sequence).toBe(520)
    expect(kernel.guestSamplesDropped).toBe(2);expect(kernel.guestSamplesOwnerDropped).toBe(8)
    for(let i=0;i<35;i++)state.worker.onmessage({data:{type:'guest-samples',value:{pid:i,samples:[],dropped:0,error:'failure '+i}}})
    expect(kernel.guestSamplingErrors).toHaveLength(32)
    expect(kernel.guestSamplingErrors[0]).toEqual({pid:3,error:'failure 3'})
    expect(kernel.jobProfile).toHaveLength(0)
  }finally{kernel.close()}
})
it('retains the latest 64 live scheduling snapshots outside ranked job profiles',async()=>{
  vi.stubGlobal('location',{href:'http://localhost/'})
  const kernel=new WorkerKernel()
  await Promise.resolve()
  try{
    for(let sequence=1;sequence<=70;sequence++)state.worker.onmessage({data:{type:'job-profile',value:{pid:1,phase:'live-scheduling',at:sequence*1000,ms:0,jobs:0,sequence,pendingFilesystemTasks:2}}})
    expect(kernel.schedulerDiagnostics).toHaveLength(64)
    expect(kernel.schedulerDiagnostics[0].sequence).toBe(7)
    expect(kernel.schedulerDiagnostics.at(-1)?.sequence).toBe(70)
    expect(kernel.jobProfile).toHaveLength(0)
  }finally{kernel.close()}
  expect(kernel.schedulerDiagnostics).toHaveLength(64)
})
it('retains worker start failures independently of duration-ranked profiling and caps recent evidence',async()=>{
  vi.stubGlobal('location',{href:'http://localhost/'})
  const kernel=new WorkerKernel()
  await Promise.resolve()
  const emit=(value:unknown)=>state.worker.onmessage({data:{type:'job-profile',value}})
  const failure=(pid:number)=>({pid,phase:'worker-start-failure' as const,at:pid,ms:0,jobs:1,workerStartError:{name:'Error',message:'ordinary start failure '+pid},workerStartScheduling:{queued:{total:pid}}})
  try{
    const first=failure(1);emit(first);first.workerStartError.message='changed producer record'
    for(let i=0;i<150;i++)emit({pid:1,phase:'job',at:i,ms:i+1,jobs:1})
    expect(kernel.jobProfile).toHaveLength(100)
    expect(kernel.jobProfile.some(row=>row.phase==='worker-start-failure')).toBe(false)
    expect(kernel.workerStartFailures).toEqual([failure(1)])
    expect(kernel.workerStartFailuresDropped).toBe(0)
    for(let i=2;i<=35;i++)emit(failure(i))
    expect(kernel.workerStartFailures).toHaveLength(32)
    expect(kernel.workerStartFailures.map(row=>row.pid)).toEqual(Array.from({length:32},(_,i)=>i+4))
    expect(kernel.workerStartFailuresDropped).toBe(3)
    expect(kernel.workerStartFailures.at(-1)).toEqual(failure(35))
  }finally{kernel.close()}
  expect(kernel.workerStartFailures).toHaveLength(32)
})
