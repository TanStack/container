import {test} from 'node:test'
import assert from 'node:assert/strict'
test('failing assertion',()=>assert.equal(1,2))
test('passing neighbor',async()=>assert.equal(await Promise.resolve(42),42))
