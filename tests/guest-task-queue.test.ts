import {it,expect} from 'vitest'
import {createContext,runInContext} from 'node:vm'
import {readFileSync} from 'node:fs'

const source=readFileSync(new URL('../src/sandbox/guest-task-queue.js',import.meta.url),'utf8')
function fixture(){
  const context=createContext({})
  runInContext(source,context)
  return {run:(code:string)=>runInContext(code,context)}
}

it('queues ticks until an explicit checkpoint and drains nested ticks FIFO',()=>{
  const f=fixture()
  expect(f.run(`const q=globalThis[Symbol.for('web-container:task-queue')],events=[];
    q.nextTick(()=>{events.push('a');q.nextTick(()=>events.push('c'))});
    q.nextTick(()=>events.push('b'));events.length`)).toBe(0)
  expect(f.run('q.pending')).toBe(2)
  expect(f.run('q.drain()')).toBe(3)
  expect(f.run('events.join(",")')).toBe('a,b,c')
  expect(f.run('q.pending')).toBe(0)
})

it('preserves receiver and arguments and drains only after the outer task',()=>{
  const f=fixture()
  expect(f.run(`const q=globalThis[Symbol.for('web-container:task-queue')],events=[];
    q.task(function(value){events.push(this.label+value);
      q.task(()=>{q.nextTick((a,b)=>events.push(a+b),'tick',42);events.push('inner')});
      events.push('outer');return 123;
    },{label:'value:'},[7])`)).toBe(123)
  expect(f.run('events.join(",")')).toBe('value:7,inner,outer,tick42')
})

it('keeps remaining ticks available after a throwing tick',()=>{
  const f=fixture()
  f.run(`const q=globalThis[Symbol.for('web-container:task-queue')],events=[];
    q.nextTick(()=>{throw Error('tick failed')});q.nextTick(()=>events.push('later'))`)
  expect(()=>f.run('q.drain()')).toThrow('tick failed')
  expect(f.run('q.pending')).toBe(1)
  expect(f.run('q.drain()')).toBe(1)
  expect(f.run('events.join(",")')).toBe('later')
})

it('captures the supplied async context binder at enqueue time',()=>{
  const f=fixture()
  expect(f.run(`let active='first';const events=[];
    globalThis.__webContainerHost={AsyncLocalStorage:{bind(callback){const captured=active;return (...args)=>{const prior=active;active=captured;try{return callback(...args)}finally{active=prior}}}}};
    const q=globalThis[Symbol.for('web-container:task-queue')];
    q.nextTick(()=>events.push(active));active='second';q.drain();events.join(',')`)).toBe('first')
  expect(f.run('active')).toBe('second')
})

it('does not execute queued ticks while a task error propagates',()=>{
  const f=fixture()
  f.run(`const q=globalThis[Symbol.for('web-container:task-queue')],events=[]`)
  expect(()=>f.run(`q.task(()=>{q.nextTick(()=>events.push('tick'));throw Error('callback failed')})`)).toThrow('callback failed')
  expect(f.run('events.length')).toBe(0)
  expect(f.run('q.pending')).toBe(1)
})
