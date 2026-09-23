import {test,it,describe,before,after,beforeEach,afterEach} from 'node:test'
import assert from 'node:assert/strict'
const order=[]
describe('ordinary suite',()=>{
  before(()=>order.push('before'));after(()=>{assert.deepEqual(order,['before','beforeEach','sync','afterEach','beforeEach','async','afterEach','beforeEach','afterEach'])})
  beforeEach(()=>order.push('beforeEach'));afterEach(()=>order.push('afterEach'))
  test('sync test',()=>{order.push('sync');assert.equal(2+2,4)})
  it('async test',async()=>{await Promise.resolve();order.push('async');assert.deepEqual(new Set([1,2]),new Set([1,2]))})
  test.skip('skipped test',()=>assert.fail('skip ran'))
  test.todo('todo test')
})
