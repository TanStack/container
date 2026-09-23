import {test,expect} from 'vitest'
import {execFileSync} from 'node:child_process'

test('Node async emitter control captures creation context and restores callers',()=>{
  const output=execFileSync(process.execPath,['tests/fixtures/async-emitter.mjs'],{encoding:'utf8'})
  expect(JSON.parse(output)).toEqual([
    ['listener','created',true,42,true],
    ['caller','caller'],
    ['promise','created'],
    ['throw','listener failure','throwing caller'],
    ['resource',true,true],
    ['return',true,false,null],
  ])
})
