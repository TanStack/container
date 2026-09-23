import {test} from 'node:test'
import assert from 'node:assert/strict'
test('not selected',()=>assert.fail('only selection failed'))
test.only('selected test',()=>assert.equal(6*7,42))
