import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {stageInterpreterProperties} from '../scripts/stage-interpreter-properties.mjs'
import {stageInterpreterFrames} from '../scripts/stage-interpreter-frames.mjs'
import {stageCallDepth} from '../scripts/stage-call-depth.mjs'

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'interpreter-properties-stage-'))
  const file=join(directory,'quickjs.c')
  writeFileSync(file,readFileSync(resolve('.toolchains/quickjs-emscripten/vendor/quickjs/quickjs.c')))
  return file
}

test('property opcode stage extracts one explicit Asyncify-visible interpreter family',()=>{
  const file=fixture()
  stageInterpreterProperties(file)
  const source=readFileSync(file,'utf8')
  assert.match(source,/static __attribute__\(\(noinline\)\) int\s+JS_ExecutePropertyOpcode/)
  assert.match(source,/typedef struct QJSPropertyOpcodeState/)
  assert.match(source,/QJS_PROPERTY_CASE\(OP_get_field\)/)
  assert.match(source,/QJS_PROPERTY_CASE\(OP_copy_data_properties\)/)
  assert.match(source,/CASE\(OP_get_field\):[\s\S]*JS_ExecutePropertyOpcode\(&property_state\)/)
  assert.match(source,/property_action == QJS_PROPERTY_EXCEPTION/)
  assert.doesNotMatch(source,/^[ \t]*CASE\(OP_get_field\):[ \t]*GET_FIELD_INLINE/m)
  assert.match(source,/CASE\(OP_add\):/)
})

test('property opcode stage fails closed on a second or partial application',()=>{
  const file=fixture()
  stageInterpreterProperties(file)
  assert.throws(()=>stageInterpreterProperties(file),/Unexpected interpreter property integration site/)

  const partial=fixture()
  writeFileSync(partial,readFileSync(partial,'utf8').replace('        CASE(OP_get_super_value):','        CASE(OP_missing_super_value):'))
  const before=readFileSync(partial)
  assert.throws(()=>stageInterpreterProperties(partial),/Missing interpreter property opcode: get_super_value/)
  assert.deepEqual(readFileSync(partial),before)
})

test('property opcode stage composes before iterative interpreter frames',()=>{
  const file=fixture()
  stageCallDepth(file)
  stageInterpreterProperties(file)
  stageInterpreterFrames(file)
  const source=readFileSync(file,'utf8')
  assert.match(source,/typedef struct QJSPropertyOpcodeState/)
  assert.match(source,/typedef struct QJSInterpreterFrame/)
  assert.match(source,/goto enter_bytecode/)
  assert.match(source,/JS_ExecutePropertyOpcode\(&property_state\)/)
})
