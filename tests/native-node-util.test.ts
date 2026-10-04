import { describe, expect, test } from 'vitest'
import * as nodeUtil from 'node:util'
import {
  format,
  inspect,
  formatWithOptions,
  isDeepStrictEqual,
  parseEnv,
  stripVTControlCharacters,
  styleText,
  TextEncoder,
  TextDecoder,
} from '../src/vite-browser/node-util'

describe('native browser worker Node utility adapter', () => {
  test('error inspection preserves the stack',()=>{
    const error=new TypeError('startup failed')
    expect(inspect(error)).toBe(nodeUtil.inspect(error))
    expect(format(error)).toBe(nodeUtil.format(error))
  })
  test('deep equality handles nested values and mismatches', () => {
    for (const [left, right] of [
      [{ a: [1, { b: true }] }, { a: [1, { b: true }] }],
      [{ a: 1 }, { a: '1' }],
      [[1, 2], [1, 3]],
      [new Map([[1, 'a']]), new Map([[1, 'a']])],
    ] as const) {
      expect(isDeepStrictEqual(left, right)).toBe(nodeUtil.isDeepStrictEqual(left, right))
    }
  })

  test('environment parsing and terminal control removal match Node', () => {
    const env = 'A=one\nB="two words"\nC=three # comment\n'
    expect(parseEnv(env)).toEqual(nodeUtil.parseEnv(env))
    const colored = '\u001b[31mred\u001b[0m text'
    expect(stripVTControlCharacters(colored)).toBe(nodeUtil.stripVTControlCharacters(colored))
  })

  test('formatting options leave shared inspect defaults unchanged', () => {
    const before = { ...nodeUtil.inspect.defaultOptions }
    expect(formatWithOptions({ colors: false }, 'value: %s %d', 'x', 3))
      .toBe(nodeUtil.formatWithOptions({ colors: false }, 'value: %s %d', 'x', 3))
    expect(nodeUtil.inspect.defaultOptions).toEqual(before)
  })

  test('console formatting leaves a string argument unquoted after a number',()=>{
    expect(format(42,'hello',{value:1})).toBe(nodeUtil.format(42,'hello',{value:1}))
  })

  test('text styling validates styles and respects a non-color stream',()=>{
    expect(styleText('red','message',{stream:{isTTY:false}})).toBe(
      nodeUtil.styleText('red','message',{stream:process.stdout}),
    )
    expect(()=>styleText('not-a-style','message')).toThrow()
    expect(styleText('dim','message',{validateStream:false})).toBe(
      nodeUtil.styleText('dim','message',{validateStream:false}),
    )
    expect(styleText(['bold','bgBlueBright'],'message',{validateStream:false})).toBe(
      nodeUtil.styleText(['bold','bgBlueBright'],'message',{validateStream:false}),
    )
  })

  test('exposes Node-compatible UTF-8 constructors',()=>{
    expect(new TextDecoder().decode(new TextEncoder().encode('hello'))).toBe('hello')
  })
})
