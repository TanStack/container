import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stageCallDepth} from '../scripts/stage-call-depth.mjs'
import {stageOpcodePatterns} from '../scripts/stage-opcode-patterns.mjs'
import {stageInterpreterFrames} from '../scripts/stage-interpreter-frames.mjs'
import {stageBatchedInterpreterMachine,batchedInterpreterMachineFamilies} from '../scripts/stage-interpreter-machine-batched.mjs'

function fixture(){const file=join(mkdtempSync(join(tmpdir(),'qjs-batched-machine-test-')),'quickjs.c');writeFileSync(file,readFileSync('.toolchains/quickjs-emscripten/vendor/quickjs/quickjs.c'));return file}
function prerequisites(file){stageCallDepth(file);stageOpcodePatterns(file);stageInterpreterFrames(file)}

test('batched machine keeps one persistent state and runs consecutive same-family opcodes',()=>{
  const file=fixture();prerequisites(file);stageBatchedInterpreterMachine(file);const source=readFileSync(file,'utf8')
  assert.equal(source.match(/QJSDispatchState dispatch_state;/g)?.length,1)
  assert.equal(source.match(/dispatch_state=\(QJSDispatchState\)\{0\};/g)?.length,1)
  assert.equal(source.match(/dispatch_state\.pc=pc;dispatch_state\.sp=sp;dispatch_state\.opcode=opcode;/g)?.length,batchedInterpreterMachineFamilies.length+1)
  assert.doesNotMatch(source,/QJSDispatchState state=\{/)
  for(const {name} of batchedInterpreterMachineFamilies){
    assert.match(source,new RegExp(`QJS_OpcodeFamily\\(\\*pc\\)==QJS_FAMILY_${name.toUpperCase()}[\\s\\S]*opcode=\\*pc\\+\\+;goto qjs_handler_dispatch`))
    assert.match(source,new RegExp(`#define QJS_${name.toUpperCase()}_BREAK goto qjs_handler_next`))
  }
  assert.match(source,/restart:\n    dispatch_state=\(QJSDispatchState\)\{0\};/)
  const restartRefresh=source.slice(source.indexOf(' restart:\n    dispatch_state='),source.indexOf('    for(;;) {',source.indexOf(' restart:\n    dispatch_state=')))
  assert.doesNotMatch(restartRefresh,/dispatch_state\.opcode=opcode/)
  for(const initialized of ['caller_ctx','ctx','rt','p','b','sf','pc','argc','flags','this_obj','new_target','argv','stack_buf','var_buf','arg_buf','sp','var_refs'])assert.match(restartRefresh,new RegExp(`dispatch_state\\.${initialized}=${initialized}`))
  assert.ok(source.indexOf(' enter_bytecode:')<source.indexOf(' restart:\n    dispatch_state='))
  const parentRestore=source.slice(source.indexOf('if (parents) {'),source.indexOf('return ret_val;',source.indexOf('if (parents) {')))
  assert.match(parentRestore,/goto restart;/)
  assert.match(source,/dispatch_state\.pc=pc;dispatch_state\.sp=sp;dispatch_state\.opcode=opcode;\n              int action=JS_ExecuteCallOpcodes\(&dispatch_state\)/)
})

test('batched opcode classifier is exact and fail closed',()=>{
  const file=fixture();prerequisites(file);stageBatchedInterpreterMachine(file);const source=readFileSync(file,'utf8')
  const classifier=source.slice(source.indexOf('static int QJS_OpcodeFamily'),source.indexOf('static JSValue JS_CallInternal',source.indexOf('static int QJS_OpcodeFamily')))
  const expected=batchedInterpreterMachineFamilies.flatMap(({opcodes})=>opcodes).sort()
  const actual=[...classifier.matchAll(/case OP_(\w+):/g)].map(match=>match[1]).sort()
  assert.deepEqual(actual,expected)
  assert.match(classifier,/default: return -1;/)
  const corrupted=fixture();prerequisites(corrupted);writeFileSync(corrupted,readFileSync(corrupted,'utf8').replace('        CASE(OP_get_super_value):','        CASE(OP_missing_super_value):'));const before=readFileSync(corrupted)
  assert.throws(()=>stageBatchedInterpreterMachine(corrupted),/Unexpected Property family source/)
  assert.deepEqual(readFileSync(corrupted),before)
})

test('batched helpers only load fields used by their pinned family',()=>{
  const file=fixture();prerequisites(file);stageBatchedInterpreterMachine(file);const source=readFileSync(file,'utf8')
  const stack=source.slice(source.indexOf('JS_ExecuteStackOpcodes'),source.indexOf('JS_ExecuteLocalsOpcodes'))
  assert.doesNotMatch(stack,/arg_allocated_size|local_buf|func_obj/)
  const terminal=source.slice(source.indexOf('JS_ExecuteTerminalOpcodes'),source.indexOf('#define QJS_TERMINAL_CASE'))
  for(const field of ['ctx','pc','opcode','sp'])assert.match(terminal,new RegExp(`state->${field}`))
  assert.doesNotMatch(terminal,/state->(?:sf|flags|var_buf|arg_buf|var_refs)/)
})

test('batched transitions consume each opcode once and retain branch polling',()=>{
  const file=fixture();prerequisites(file);stageBatchedInterpreterMachine(file);const source=readFileSync(file,'utf8')
  const locals=source.slice(source.indexOf('JS_ExecuteLocalsOpcodes'),source.indexOf('JS_ExecuteIteratorOpcodes'))
  for(const opcode of ['goto','goto16','goto8','if_true','if_false','if_true8','if_false8']){
    const start=locals.indexOf(`QJS_LOCALS_CASE(OP_${opcode}):`)
    const end=locals.indexOf('QJS_LOCALS_BREAK;',start)
    assert.ok(start>=0&&end>start)
    assert.match(locals.slice(start,end),/js_poll_interrupts\(ctx\)/)
  }
  assert.match(source,/if\(QJS_OpcodeFamily\(\*pc\)==QJS_FAMILY_LOCALS\)\{opcode=\*pc\+\+;goto qjs_handler_dispatch;\}/)
  assert.match(source,/qjs_handler_continue:\n  state->pc=pc;/)
  assert.match(source,/for\(;;\) \{[\s\S]*SWITCH\(pc\) \{/)
  const stream=['Stack','Stack','Numeric','Numeric','Locals'];let cursor=1,opcode=stream[0],executed=[opcode]
  while(cursor<stream.length&&stream[cursor]===opcode){opcode=stream[cursor++];executed.push(opcode)}
  while(cursor<stream.length){opcode=stream[cursor++];executed.push(opcode);while(cursor<stream.length&&stream[cursor]===opcode){opcode=stream[cursor++];executed.push(opcode)}}
  assert.deepEqual(executed,stream)
  assert.equal(cursor,stream.length)
})

test('build integration keeps batching behind a distinct provenance-bearing flag',()=>{
  const build=readFileSync('scripts/build-quickjs-als.mjs','utf8')
  assert.match(build,/process\.argv\.includes\('--segment-interpreter-batched'\)/)
  assert.match(build,/if\(segmentedInterpreter&&batchedSegmentedInterpreter\)throw Error/)
  assert.match(build,/batchedSegmentedInterpreter\?'persistent-state-family-runs':'single-opcode-family-dispatch'/)
  assert.match(build,/batchedSegmentedInterpreter\?\{baseStageSHA256:hash\(readFileSync\('scripts\/stage-interpreter-machine\.mjs'\)\)\}:\{\}/)
  assert.match(build,/batchedSegmentedInterpreter\?'-interpreter-machine-batched':''/)
  assert.match(build,/stageBatchedInterpreterMachine\(join\(qjs,'quickjs\.c'\)\)/)
})
