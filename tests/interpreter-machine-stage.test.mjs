import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stageCallDepth} from '../scripts/stage-call-depth.mjs'
import {stageOpcodePatterns} from '../scripts/stage-opcode-patterns.mjs'
import {stageInterpreterFrames} from '../scripts/stage-interpreter-frames.mjs'
import {stageInterpreterMachine,interpreterMachineFamilies} from '../scripts/stage-interpreter-machine.mjs'

function fixture(){const file=join(mkdtempSync(join(tmpdir(),'qjs-machine-stage-')),'quickjs.c');writeFileSync(file,readFileSync('.toolchains/quickjs-emscripten/vendor/quickjs/quickjs.c'));return file}
function prerequisites(file){stageCallDepth(file);stageOpcodePatterns(file);stageInterpreterFrames(file)}

test('machine stage extracts the pinned complete ordinary opcode inventory',()=>{
  const file=fixture();prerequisites(file);stageInterpreterMachine(file);const source=readFileSync(file,'utf8')
  for(const {name,opcodes} of interpreterMachineFamilies){assert.match(source,new RegExp(`JS_Execute${name}Opcodes`));for(const opcode of opcodes)assert.match(source,new RegExp(`CASE\\(OP_${opcode}\\):`))}
  for(const action of ['CONTINUE','EXCEPTION','ENTER_BYTECODE','RETURN','YIELD'])assert.match(source,new RegExp(`QJS_ACTION_${action}`))
  assert.match(source,/JS_ExecuteCallOpcodes[\s\S]*return QJS_ACTION_ENTER_BYTECODE/)
  assert.match(source,/JS_ExecuteCallOpcodes[\s\S]*return QJS_ACTION_RETURN/)
  assert.match(source,/JS_ExecuteTerminalOpcodes[\s\S]*return QJS_ACTION_YIELD/)
  assert.equal(source.match(/rt->interpreter_frame_depth\+\+/g)?.length,1)
  assert.equal(source.match(/next=js_malloc\(ctx,sizeof\(\*next\)\+bytes\)/g)?.length,1)
  const callHelper=source.slice(source.indexOf('static __attribute__((noinline)) int JS_ExecuteCallOpcodes'),source.indexOf('/* argv[] is modified'))
  assert.doesNotMatch(callHelper,/interpreter_frame_depth|QJSInterpreterFrame/)
  assert.match(source,/typedef struct QJSInterpreterFrame/);assert.match(source,/goto enter_bytecode/);assert.match(source,/exception:/);assert.match(source,/done_generator:/)
})

test('machine stage is fail closed and failure atomic',()=>{
  const file=fixture();prerequisites(file);let source=readFileSync(file,'utf8');source=source.replace('        CASE(OP_get_super_value):','        CASE(OP_missing_super_value):');writeFileSync(file,source);const before=readFileSync(file)
  assert.throws(()=>stageInterpreterMachine(file),/Unexpected Property family source/);assert.deepEqual(readFileSync(file),before)
})

test('machine stage hashes call bodies, not only their anchors',()=>{
  const file=fixture();prerequisites(file)
  const source=readFileSync(file,'utf8').replace('next->argument_prefix = 1;','next->argument_prefix = 9;')
  assert.notEqual(source,readFileSync(file,'utf8'));writeFileSync(file,source);const before=readFileSync(file)
  assert.throws(()=>stageInterpreterMachine(file),/Unexpected direct call transition source/)
  assert.deepEqual(readFileSync(file),before)
})

test('machine stage rejects partial or duplicate application',()=>{const file=fixture();prerequisites(file);stageInterpreterMachine(file);assert.throws(()=>stageInterpreterMachine(file),/already staged/)})
