import {it,expect} from 'vitest'
import {CooperativeYield} from '../src/sandbox/cooperative-yield'

it('resumes asynchronously, permits another yield and closes its ports',async()=>{
  const yielding=new CooperativeYield(),seen:number[]=[]
  try{
    const done=new Promise<void>(resolve=>yielding.schedule(()=>{
      seen.push(1)
      yielding.schedule(()=>{seen.push(2);resolve()})
    }))
    expect(seen).toEqual([])
    expect(()=>yielding.schedule(()=>{})).toThrow('already pending')
    expect(()=>yielding.close()).toThrow('suspended')
    await done
    expect(seen).toEqual([1,2])
  }finally{yielding.close()}
  yielding.close()
  expect(()=>yielding.schedule(()=>{})).toThrow('closed')
})

it('can close before allocating ports',()=>{
  const yielding=new CooperativeYield()
  yielding.close()
  expect(()=>yielding.schedule(()=>{})).toThrow('closed')
})
