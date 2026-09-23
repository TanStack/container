import {test,expect} from 'vitest'
import {createModuleSourceBudget,moduleSourceLimit,processSourceLimit} from '../src/sandbox/module-source-budget'

test('source boundaries retain existing per-module and process admission',()=>{
  const charge=createModuleSourceBudget()
  for(let i=0;i<4;i++)expect(()=>charge('/part'+i,moduleSourceLimit)).not.toThrow()
  expect(()=>charge('/empty',0)).not.toThrow()
  try{charge('/next',1);throw Error('Expected source limit')}
  catch(error){expect(error).toMatchObject({code:'ERR_MODULE_SOURCE_LIMIT',scope:'process',path:'/next',observedBytes:processSourceLimit+1,limitBytes:processSourceLimit})}
})

test('oversized module identifies its path and preserves failed-read accounting',()=>{
  const charge=createModuleSourceBudget(),path='/project/compiler\nname.js'
  expect(()=>charge(path,moduleSourceLimit+1)).toThrow(JSON.stringify(path))
  for(let i=0;i<2;i++)charge('/part',moduleSourceLimit)
  expect(()=>charge('/third',moduleSourceLimit)).toThrow(`process source bytes ${processSourceLimit+1}`)
})

test('invalid counts are rejected without charging or allocating source content',()=>{
  const charge=createModuleSourceBudget()
  for(const value of [-1,0.5,NaN,Infinity])expect(()=>charge('/bad',value)).toThrow(TypeError)
  for(let i=0;i<4;i++)charge('/part',moduleSourceLimit)
  expect(()=>charge('/empty',0)).not.toThrow()
})
