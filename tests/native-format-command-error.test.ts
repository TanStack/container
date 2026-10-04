import {expect,it} from 'vitest'
import {formatCommandError} from '../src/native/format-command-error'
import {workerSourceLocations} from '../src/native/browser-source-locations'

it('includes the error message when a browser stack contains frames only',()=>{
  const error=new Error('unhandled probe')
  error.stack='anonymous@/app/reject.mjs:1:1\nrunInlinedModule@engine.js:2:2'
  expect(formatCommandError(error)).toBe(
    'Error: unhandled probe\nanonymous@/app/reject.mjs:1:1\nrunInlinedModule@engine.js:2:2',
  )
})

it('does not repeat the message when the stack already starts with it',()=>{
  const error=new Error('unhandled probe')
  error.stack='Error: unhandled probe\n    at /app/reject.mjs:1:1'
  expect(formatCommandError(error)).toBe(error.stack)
})

it('preserves non-error rejection values',()=>{
  expect(formatCommandError('failure')).toBe('failure')
})

it('maps captured implicit-error locations for terminal output without changing the error',()=>{
  const unregister=workerSourceLocations.register('blob:owned-command',(line,column)=>({file:'/app/command.ts',line:line-2,column}))
  try{
    const error=new TypeError('owned implicit error')
    const stack='owned@blob:owned-command:5:9\nunknown@blob:other:1:1'
    error.stack=stack
    expect(formatCommandError(error)).toBe('TypeError: owned implicit error\nowned@/app/command.ts:3:9\nunknown@blob:other:1:1')
    expect(error.stack).toBe(stack)
  }finally{unregister()}
})
