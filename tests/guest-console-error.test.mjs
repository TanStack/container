import {test} from 'node:test'
import assert from 'node:assert/strict'
import {formatGuestConsoleError} from '../src/sandbox/guest-console-error.js'

test('QuickJS error frames receive the missing name and message',()=>{
  const error=new TypeError('not a function')
  error.stack='    at render (/project/server.js:42:7)\n'
  assert.equal(formatGuestConsoleError(error),'TypeError: not a function\n    at render (/project/server.js:42:7)\n')
})
test('Node stack is preserved without duplicating its heading',()=>{
  const error=new TypeError('not a function')
  assert.equal(formatGuestConsoleError(error),error.stack)
  const multiline=new Error('first\nsecond')
  assert.equal(formatGuestConsoleError(multiline),multiline.stack)
})
test('errors without a stack still identify the error',()=>{
  const error=new Error('failed');error.stack=''
  assert.equal(formatGuestConsoleError(error),'Error: failed')
  error.message='';assert.equal(formatGuestConsoleError(error),'Error')
})
test('serialized guest helper has no host closure dependencies',()=>{
  const guestFormatter=(0,eval)(`(${formatGuestConsoleError.toString()})`)
  const error=new Error('failed');error.stack='    at guest.js:1\n'
  assert.equal(guestFormatter(error),'Error: failed\n    at guest.js:1\n')
})
