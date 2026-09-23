import {test,expect} from 'vitest'
import {ExecutionBudget,processLifetime} from '../src/sandbox/execution-budget'

test('bounded execution keeps its wall deadline through idle and ready turns',()=>{
  let now=0;const budget=new ExecutionBudget(10,'bounded',()=>now)
  budget.endTurn(false);now=9;budget.beginTurn();expect(budget.expired).toBe(false)
  budget.endTurn(true);now=11;budget.beginTurn();expect(budget.expired).toBe(true)
})
test('budget snapshots do not start idle turns or renew expired deadlines',()=>{
  let now=0;const budget=new ExecutionBudget(10,'session',()=>now)
  expect(budget.snapshot()).toMatchObject({deadline:10,remainingMs:10})
  budget.endTurn(false);now=100
  expect(budget.snapshot()).toMatchObject({deadline:null,remainingMs:null})
  expect(budget.waitTimeout).toBeUndefined()
  budget.beginTurn();now=111
  expect(budget.snapshot()).toMatchObject({deadline:110,remainingMs:-1})
  expect(budget.expired).toBe(true)
})
test('session I/O waits do not consume the next turn',()=>{
  let now=0;const budget=new ExecutionBudget(10,'session',()=>now)
  now=5;budget.endTurn(false);expect(budget.waitTimeout).toBeUndefined()
  now=10000;budget.beginTurn();expect(budget.expired).toBe(false)
  now=10009;budget.beginTurn();expect(budget.expired).toBe(false)
  now=10011;expect(budget.expired).toBe(true)
})
test('ready microtasks cannot renew a session deadline',()=>{
  let now=0;const budget=new ExecutionBudget(10,'session',()=>now)
  for(now=1;now<10;now++){budget.endTurn(true);budget.beginTurn();expect(budget.expired).toBe(false)}
  now=11;expect(budget.expired).toBe(true)
})
test('finishing an over-budget turn cannot erase the failure',()=>{
  let now=0;const budget=new ExecutionBudget(10,'session',()=>now)
  now=11;budget.endTurn(false);budget.beginTurn();expect(budget.expired).toBe(true)
})
test('interrupt entry after idle starts a bounded turn even without an explicit begin',()=>{
  let now=0;const budget=new ExecutionBudget(10,'session',()=>now)
  budget.endTurn(false);now=100;expect(budget.expired).toBe(false)
  now=111;expect(budget.expired).toBe(true)
})
test('only host authority or a session parent can create a session child',()=>{
  expect(processLifetime(undefined)).toBe('bounded')
  expect(processLifetime('session')).toBe('session')
  expect(processLifetime(undefined,'session')).toBe('session')
  expect(processLifetime('bounded','session')).toBe('bounded')
  expect(()=>processLifetime('session','bounded')).toThrow('cannot create')
  for(const value of [null,false,0,'forever',{}])expect(()=>processLifetime(value)).toThrow('Invalid')
})
