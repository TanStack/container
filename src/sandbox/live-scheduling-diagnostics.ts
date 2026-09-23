// Passive sampling only. Callers reuse existing scheduler boundaries, never a timer.
export function createLiveSchedulingDiagnostics(sample:(at:number,sequence:number)=>void,clock=()=>performance.now()){
  let count=0,last=-Infinity
  return ()=>{
    if(count>=64)return
    try{
      const at=clock()
      if(at-last<1000)return
      last=at
      sample(at,++count)
    }catch{/* Observation must not change runtime scheduling or failure handling. */}
  }
}

export type FiberDiagnosticPhase='evaluation'|'jobs'|'nextTick'
export function createFiberPhaseTiming(){
  const totals={evaluation:{steps:0,totalMs:0,maxMs:0},jobs:{steps:0,totalMs:0,maxMs:0},nextTick:{steps:0,totalMs:0,maxMs:0}}
  let lastStep:{phase:FiberDiagnosticPhase;durationMs:number;status:number|undefined}|undefined
  return {
    observe(phase:FiberDiagnosticPhase,durationMs:number,status:number|undefined){
      const total=totals[phase]
      total.steps++;total.totalMs+=durationMs;total.maxMs=Math.max(total.maxMs,durationMs)
      lastStep={phase,durationMs,status}
    },
    snapshot(){return {lastStep:lastStep?{...lastStep}:undefined,byPhase:{evaluation:{...totals.evaluation},jobs:{...totals.jobs},nextTick:{...totals.nextTick}}}},
  }
}
