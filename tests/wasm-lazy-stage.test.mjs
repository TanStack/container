import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stageWasmLazyCompilation} from '../scripts/stage-wasm-lazy-compilation.mjs'

const names=['m3_function.h','m3_compile.c','m3_exec.h']
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'wasm-lazy-stage-'))
  for(const name of names)writeFileSync(join(directory,name),readFileSync(join('.toolchains/wasm3/source',name)))
  return directory
}
test('stages failure-safe publication without removing eager validation',()=>{
  const directory=fixture();stageWasmLazyCompilation(directory)
  const compiler=readFileSync(join(directory,'m3_compile.c'),'utf8')
  const functionBody=compiler.slice(compiler.indexOf('M3Result CompileFunction ('))
  assert.ok(functionBody.indexOf('if (io_function->compilationFailed)')<functionBody.indexOf('ValidateFunction(io_function)'))
  assert.ok(functionBody.indexOf('io_function->compiled = pc;')>functionBody.indexOf('_throwifnull(io_function->constants)'))
  assert.match(functionBody,/if \(result\) io_function->compilationFailed = true;/)
  assert.match(functionBody,/return "previous WASM function compilation failed"/)
  assert.match(functionBody,/ReleaseCompilationCodePage\(o\)/)
  const exec=readFileSync(join(directory,'m3_exec.h'),'utf8')
  for(const [operation,target] of [['Compile','Call'],['CompileReturnCall','ReturnCall']]){
    const start=exec.indexOf(`d_m3Op(${operation})`),end=exec.indexOf('\n}\n',start)
    const body=exec.slice(start,end)
    assert.ok(body.indexOf(`rewrite_op(op_${target})`)>body.indexOf('if (not result)'))
    assert.ok(body.indexOf(`rewrite_op(op_${target})`)>body.indexOf('*((void**)--_pc)'))
    assert.ok(body.includes(`*((void**)--_pc) = (void*)(function->compiled);\n        rewrite_op(op_${target});\n        --_pc;\n        nextOpDirect();`),'operand decrement restores operand slot, rewrite targets previous opcode, final decrement resumes opcode')
    assert.match(body,/newTrap\(result\)/)
  }
})
test('anchor mismatch changes none of the staged files',()=>{
  const directory=fixture()
  writeFileSync(join(directory,'m3_exec.h'),'changed upstream')
  const before=names.map(name=>readFileSync(join(directory,name),'utf8'))
  assert.throws(()=>stageWasmLazyCompilation(directory),/Unexpected lazy compilation/)
  names.forEach((name,index)=>assert.equal(readFileSync(join(directory,name),'utf8'),before[index]))
})
