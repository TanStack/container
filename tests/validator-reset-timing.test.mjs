import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,copyFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {stageValidatorControl} from '../scripts/stage-validator-control.mjs'

const names=['m3_validate.c','m3_validate.h','m3_env.c']
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'validator-reset-timing-'))
  for(const name of names)copyFileSync(join('.toolchains/wasm3/source',name),join(directory,name))
  execFileSync('patch',['-p2','-d',directory,'-i',resolve('patches/wasm3-validator-diagnostics.patch')],{stdio:'pipe'})
  return directory
}

test('observes the full validator reset without changing reset or validation checks',()=>{
  const directory=fixture()
  const original=readFileSync(join(directory,'m3_validate.c'),'utf8')
  stageValidatorControl(directory)
  const staged=readFileSync(join(directory,'m3_validate.c'),'utf8')
  assert.equal(original.split('memset(v, 0, sizeof(*v));').length,2)
  assert.equal(staged.split('memset(v, 0, sizeof(*v));').length,2)
  assert.ok(staged.includes(`    ValCtrlFrame *ctrl = v->ctrl;
    u32 capacity = v->ctrlCapacity;
    extern double QWasm_ValidatorResetTimingBegin(void);
    extern void QWasm_ValidatorResetTimingEnd(double, size_t);
    double resetStart = QWasm_ValidatorResetTimingBegin();
    memset(v, 0, sizeof(*v));
    QWasm_ValidatorResetTimingEnd(resetStart, sizeof(*v));
    v->ctrl = ctrl;
    v->ctrlCapacity = capacity;`))
  assert.equal(staged.split('QWasm_ValidatorResetTimingBegin();').length,2)
  assert.equal(staged.split('QWasm_ValidatorResetTimingEnd(resetStart, sizeof(*v));').length,2)
  // Existing checks may be strengthened by this stage, never removed.
  for(const line of original.split('\n').filter(line=>/\breturn m3Err_/.test(line))) {
    assert.ok(staged.includes(line),`Missing validation return: ${line.trim()}`)
  }
  assert.match(staged,/if \(!v->module->globals\[idx\]\.isMutable\) return m3Err_settingImmutableGlobal;/)
  assert.match(staged,/Unsupported instructions cannot establish a valid module\.\n\s+return m3Err_wasmMalformed;/)
})

test('rejects repeated staging without changing the staged files',()=>{
  const directory=fixture();stageValidatorControl(directory)
  const before=names.map(name=>readFileSync(join(directory,name),'utf8'))
  assert.throws(()=>stageValidatorControl(directory),/Unexpected validator control site/)
  names.forEach((name,index)=>assert.equal(readFileSync(join(directory,name),'utf8'),before[index]))
})
