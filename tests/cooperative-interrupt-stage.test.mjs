import {test} from 'node:test'
import assert from 'node:assert/strict'
import {stageCooperativeInterrupt} from '../scripts/stage-cooperative-interrupt.mjs'

const original=`  // Async not supported here.
  // #ifdef QTS_ASYNCIFY
  //   const asyncify = Asyncify;
  // #else
  const asyncify = undefined;
  // #endif
  return Module['callbacks']['shouldInterrupt'](asyncify, rt);`

for(const profiling of [false,true])test(`cooperative interrupt fast path and rewind, profiling=${profiling}`,()=>{
  const run=new Function('Module','Asyncify','performance','rt',stageCooperativeInterrupt(original,profiling))
  let now=101,checks=0,sleeps=0,resume
  const module={lastInterruptYield:100,callbacks:{shouldInterrupt:()=>{checks++;return 7}},scheduleCooperativeYield:callback=>{resume=callback}}
  const asyncify={state:0,State:{Normal:0},handleSleep(start){
    sleeps++
    if(this.state===2){this.state=0;return 7}
    start(value=>{this.result=value})
    return 0
  }}
  const clock={now:()=>now}
  assert.equal(run(module,asyncify,clock,42),7)
  assert.equal(checks,1)
  assert.equal(sleeps,0)
  now=110
  assert.equal(run(module,asyncify,clock,42),0)
  assert.equal(sleeps,1)
  assert.equal(checks,1)
  now=115;resume()
  assert.equal(module.lastInterruptYield,115)
  assert.equal(checks,2)
  asyncify.state=2
  module.cooperativeScheduling=false
  assert.equal(run(module,asyncify,clock,42),7)
  assert.equal(sleeps,2)
  assert.equal(asyncify.state,0)
  assert.equal(checks,2)
  now=200
  assert.equal(run(module,asyncify,clock,42),7)
  assert.equal(sleeps,2)
  assert.equal(checks,3)
  if(profiling)assert.deepEqual(module.cooperativeMetrics,{yields:1,waitMs:5,maxWaitMs:5})
})
