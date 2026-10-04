import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {init as initWasm,parse as parseWasm} from 'cjs-module-lexer'

const require=createRequire(import.meta.url)
const {init:initJavaScript,parse:parseJavaScript}=require('cjs-module-lexer')

test('the browser-native JavaScript CommonJS lexer matches the package Wasm lexer',async()=>{
  await Promise.all([initWasm(),initJavaScript()])
  const sources=[
    'exports.answer = 42; module.exports.extra = true',
    'Object.defineProperty(exports, "value", { enumerable: true, get() { return 1 } })',
    'module.exports = require("./other")',
    'exports["quoted"] = 1; exports[\'singleQuoted\'] = 2',
    '/* exports.fake = 1 */ const text = "module.exports.nope = 1"; exports.real = text',
    'for (const value of [1, 2]) { exports.item = value }',
  ]
  for(const source of sources){
    const actual=parseJavaScript(source)
    const expected=parseWasm(source)
    assert.deepEqual(actual,expected,source)
  }
})
