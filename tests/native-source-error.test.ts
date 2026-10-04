import {expect,test} from 'vitest'
import {normalizeSourceError} from '../src/native/source-error'
test('maps only verified source parser errors to SyntaxError',()=>{
  const parser=Object.assign(Error('Unexpected token'),{code:'PARSE_ERROR'})
  const result=normalizeSourceError(parser)
  expect(result).toBeInstanceOf(SyntaxError)
  expect((result as Error).cause).toBe(parser)
  expect((result as Error).message).toBe('Unexpected token')
  for(const error of [Error('owned rejection'),Object.assign(Error('missing'),{code:'ERR_MODULE_NOT_FOUND'}),null])
    expect(normalizeSourceError(error)).toBe(error)
})
