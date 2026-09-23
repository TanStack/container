import {test,expect} from 'vitest'
import native from 'node:test/reporters'
import {once} from 'node:events'
// @ts-expect-error The guest source intentionally has no declaration file.
import * as guest from '../src/sandbox/guest-test-reporters.js'

const events=[
  {type:'test:start',data:{nesting:0,name:'passes',line:1,column:1,file:'fixture.mjs'}},
  {type:'test:pass',data:{name:'passes',nesting:0,testNumber:1,details:{duration_ms:1,type:'test'},line:1,column:1,file:'fixture.mjs'}},
  {type:'test:start',data:{nesting:0,name:'skips',line:2,column:1,file:'fixture.mjs'}},
  {type:'test:pass',data:{name:'skips',nesting:0,testNumber:2,details:{duration_ms:0,type:'test'},skip:'why',line:2,column:1,file:'fixture.mjs'}},
  {type:'test:start',data:{nesting:0,name:'fails',line:3,column:1,file:'fixture.mjs'}},
  {type:'test:fail',data:{name:'fails',nesting:0,testNumber:3,details:{duration_ms:2,type:'test',error:Object.assign(Error('boom'),{code:'ERR_TEST_FAILURE',stack:'Error: boom\n    at fixture.mjs:3:1'})},line:3,column:1,file:'fixture.mjs'}},
  {type:'test:plan',data:{nesting:0,count:3}},
  {type:'test:diagnostic',data:{nesting:0,message:'tests 3',level:'info'}},
  {type:'test:diagnostic',data:{nesting:0,message:'pass 1',level:'info'}},
  {type:'test:diagnostic',data:{nesting:0,message:'skipped 1',level:'info'}},
  {type:'test:summary',data:{success:true,counts:{tests:2,failed:0,passed:1,cancelled:0,skipped:1,todo:0,topLevel:2,suites:0},duration_ms:1}},
]
const source=()=>({async *[Symbol.asyncIterator](){yield* events}})
const generated=async(fn:any)=>{let output='';for await(const chunk of fn(source()))output+=chunk;return output}
const transformed=async(fn:any)=>{const stream=fn(),chunks:string[]=[];stream.on('data',(chunk:any)=>chunks.push(String(chunk)));for(const event of events)stream.write(event);stream.end();await once(stream,'end');return chunks.join('')}

test('TAP, dot and JUnit transforms match native deterministic events',async()=>{
  for(const name of ['tap','dot','junit'] as const)expect(await generated(guest[name])).toBe(await generated(native[name]))
})
test('spec transform matches native deterministic events and lcov stays honest',async()=>{
  expect(await transformed(guest.spec)).toBe(await transformed(native.spec))
  expect(guest).not.toHaveProperty('lcov')
})
