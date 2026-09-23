import {test,expect} from 'vitest'
import native from 'node:diagnostics_channel'
// @ts-expect-error The guest source intentionally has no host declaration file.
import * as guest from '../src/sandbox/guest-diagnostics-channel.js'

const exercise=(api:typeof native,name:string)=>{
  const seen:any[]=[]
  const listener=(message:any,channelName:string|symbol)=>seen.push([message,channelName])
  const first=api.channel(name)
  const identity=first===api.channel(name)
  const before=[first.hasSubscribers,api.hasSubscribers(name)]
  api.subscribe(name,listener);first.publish({value:1})
  const subscribed=[first.hasSubscribers,api.hasSubscribers(name)]
  const absent=api.unsubscribe(name,()=>{}),invalid=first.unsubscribe(null as any),removed=first.unsubscribe(listener),again=api.unsubscribe(name,listener)
  return {identity,before,seen,subscribed,absent,invalid,removed,again,after:first.hasSubscribers}
}
const trace=async(api:typeof native)=>{
  const tracing=api.tracingChannel('unit.trace.'+Math.random()),seen:any[]=[]
  for(const part of ['start','end','asyncStart','asyncEnd','error'] as const)tracing[part].subscribe((context:any)=>seen.push([part,{...context,error:context.error?.message}]))
  const sync=tracing.traceSync((a,b)=>a+b,{kind:'sync'},null,2,3)
  let failure='';try{tracing.traceSync(()=>{throw Error('sync failure')},{kind:'failure'})}catch(error){failure=(error as Error).message}
  const promised=await tracing.tracePromise(async()=>7,{kind:'promise'})
  let rejected='';try{await tracing.tracePromise(async()=>{throw Error('promise failure')},{kind:'rejection'})}catch(error){rejected=(error as Error).message}
  return {sync,failure,promised,rejected,seen}
}

test('channel registry, subscriptions and removals match native Node',()=>{
  const name='unit.'+Math.random()
  expect(exercise(guest as any,name)).toEqual(exercise(native,name))
})
test('tracing channels match native sync and promise event order and context',async()=>expect(await trace(guest as any)).toEqual(await trace(native)))
