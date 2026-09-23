const compute=count=>{let total=0;for(let i=0;i<count;i++)total=(total+(i%97))%1000000007;return total}
const check=(value,message)=>{if(!value)throw Error(message)}

export async function runFairnessCandidate(engine){
  const deadline=performance.now()+5000,states=[],active=new Set(),events=[]
  const make=(index)=>{
    const runtime=engine.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024)
    runtime.setInterruptHandler(()=>performance.now()>deadline)
    const context=runtime.newContext(),state={runtime,context,index};states.push(state);return state
  }
  const start=(state,source)=>{
    const fn=state.context.unwrapResult(state.context.evalCode(source))
    try{const fiber=state.context.startFiberCall(fn);active.add(fiber);return fiber}finally{fn.dispose()}
  }
  const finish=(state,fiber)=>{
    const result=fiber.takeResult()
    try{return state.context.dump(state.context.unwrapResult(result))}finally{result.dispose();fiber.dispose();active.delete(fiber)}
  }
  const drive=(fiber)=>{for(let i=0;i<1000;i++){const status=fiber.step();if(status===2)return;check(status===3,'Only fairness suspension expected')}throw Error('Finite fixture exceeded step bound')}
  try{
    const a=make(0),b=make(1),counts=[1000000,1001000]
    const tasks=[a,b].map((state,i)=>({state,count:counts[i],fiber:start(state,`()=>(${compute.toString()})(${counts[i]})`),done:false,yields:0}))
    let timerRan=false,timerBeforeCompletion=false
    const timer=setTimeout(()=>{timerRan=true;timerBeforeCompletion=tasks.some(task=>!task.done)},0)
    try{
      for(let round=0;tasks.some(task=>!task.done)&&round<1000;round++){
        for(const task of tasks){if(task.done)continue
          const status=task.fiber.step();events.push({runtime:task.state.index,status})
          if(status===3){
            task.yields++;check(!task.fiber.deliver(0),'Fairness is not a value-delivery wait')
            if(task.yields===1){
              let rejected=false
              try{task.state.context.startFiberEval('42','second.js')}catch{rejected=true}
              check(rejected,'Second fiber in a suspended runtime must be rejected')
            }
          }
          else{check(status===2,'CPU fixture must yield or finish');check(finish(task.state,task.fiber)===compute(task.count),'Arithmetic parity');task.done=true}
        }
        await new Promise(resolve=>setTimeout(resolve,0))
      }
      check(tasks.every(task=>task.done&&task.yields>0),'Both computations must yield and finish')
      check(events[0].status===3&&events[1].status===3,'Both runtimes progress before either finishes')
      check(timerRan&&timerBeforeCompletion,'Host task progresses during finite compute')
    }finally{clearTimeout(timer)}

    const cancelled=start(a,`()=>(${compute.toString()})(1000000)`)
    check(cancelled.step()===3,'Cancellation fixture first yields')
    check(cancelled.cancel(),'Cancellation accepted at fairness boundary')
    check(cancelled.step()===2,'Cancellation unwinds without another fairness pause')
    const rejected=cancelled.takeResult()
    check(Boolean(rejected.error),'Cancellation returns a guest error');rejected.dispose();cancelled.dispose();active.delete(cancelled)

    const ordering=start(a,`()=>{globalThis.order=['start'];Promise.resolve().then(()=>order.push('microtask'));(${compute.toString()})(1000000);order.push('end');return order.join(',')}`)
    drive(ordering);check(finish(a,ordering)==='start,end','No same-runtime microtask reentry while suspended')
    while(a.runtime.hasPendingJob()){const jobs=await a.runtime.executePendingJobs();if(jobs.error){jobs.dispose();throw Error('Promise job failed')}jobs.dispose()}
    const order=a.context.unwrapResult(a.context.evalCode('order.join(",")'));check(a.context.getString(order)==='start,end,microtask','Promise order preserved');order.dispose()

    const errorTask=start(a,`()=>{(${compute.toString()})(1000000);throw Error('original after yield')}`)
    drive(errorTask);const errorResult=errorTask.takeResult()
    check(Boolean(errorResult.error)&&a.context.dump(errorResult.error).message==='original after yield','Original exception preserved')
    errorResult.dispose();errorTask.dispose();active.delete(errorTask)

    const callback=a.context.newFunction('nestedCompute',()=>a.context.unwrapResult(a.context.evalCode(`(${compute.toString()})(1000000)`)))
    a.context.setProp(a.context.global,'nestedCompute',callback);callback.dispose()
    const callbackTask=start(a,'()=>nestedCompute()')
    check(callbackTask.step()===2,'No fairness suspension across a host callback')
    check(finish(a,callbackTask)===compute(1000000),'Host callback computation parity')
    const moduleCrossings=[]
    for(const crossing of ['loader','normalizer']){
      const state=make(states.length),calls={loader:0,normalizer:0},answers=[]
      const nested=()=>{
        const value=state.context.unwrapResult(state.context.evalCode(`(${compute.toString()})(1000000)`))
        try{answers.push(state.context.getNumber(value))}finally{value.dispose()}
      }
      state.runtime.setModuleLoader(name=>{
        calls.loader++;check(name==='fixture:answer','Normalized module name reaches loader')
        if(crossing==='loader')nested()
        return 'export const answer=42'
      },(_base,name)=>{
        calls.normalizer++;check(name==='answer','Requested module name reaches normalizer')
        if(crossing==='normalizer')nested()
        return 'fixture:answer'
      })
      const fiber=state.context.startFiberEval('import {answer} from "answer";globalThis.loadedAnswer=answer;','module-entry.mjs',1)
      active.add(fiber)
      check(fiber.step()===2,`No fairness suspension across module ${crossing} callback`)
      finish(state,fiber)
      const value=state.context.unwrapResult(state.context.evalCode('loadedAnswer'))
      try{check(state.context.getNumber(value)===42,'Imported module executed')}finally{value.dispose()}
      check(calls.loader===1&&calls.normalizer===1,'Both module callbacks execute exactly once')
      check(answers.length===1&&answers[0]===compute(1000000),`Module ${crossing} nested computation parity`)
      moduleCrossings.push({crossing,calls,answer:answers[0],noYield:true})
    }
    return {yields:tasks.map(task=>task.yields),interleaved:true,hostTaskProgress:true,sameRuntimeSecondFiberRejected:true,cancellation:true,promiseOrdering:true,exceptionPreserved:true,hostCallbackNoYield:true,moduleCrossings}
  }finally{
    for(const fiber of active){fiber.cancel();drive(fiber);fiber.takeResult().dispose();fiber.dispose()}
    for(const {context,runtime} of states){context.dispose();runtime.dispose()}
  }
}
