import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {stageOpcodePatterns} from '../scripts/stage-opcode-patterns.mjs'

const original = `#define M2(op1, op2)            ((op1) | ((op2) << 8))
#define M3(op1, op2, op3)       ((op1) | ((op2) << 8) | ((op3) << 16))
#define M4(op1, op2, op3, op4)  ((op1) | ((op2) << 8) | ((op3) << 16) | ((op4) << 24))
static BOOL code_match(CodeContext *s, int pos, ...)
{
    op1 = va_arg(ap, int);
    if (op != (uint8_t)op1
    && op != (uint8_t)(op1 >> 8)
    && op != (uint8_t)(op1 >> 16)
    && op != (uint8_t)(op1 >> 24)) break;
}
`
function fixture(source = original) {
  const path = join(mkdtempSync(join(tmpdir(), 'opcode-pattern-test-')), 'quickjs.c')
  writeFileSync(path, source)
  return path
}
test('stages unsigned packing and extraction while preserving int varargs', () => {
  const path = fixture(); stageOpcodePatterns(path)
  const source = readFileSync(path, 'utf8')
  assert.ok(source.includes('static inline int code_pattern4(int op1, int op2, int op3, int op4)'))
  assert.ok(source.includes('((uint32_t)op4 << 24)'))
  assert.ok(source.includes('(int)(pattern & INT32_MAX) - INT32_MAX - 1'))
  assert.ok(source.includes('op1 = va_arg(ap, int);'))
  for (const bits of [8,16,24]) assert.ok(source.includes('(uint8_t)((uint32_t)op1 >> ' + bits + ')'))
  stageOpcodePatterns(path)
  assert.equal(readFileSync(path, 'utf8'), source)
})
for (const [name, source] of [
  ['missing macro', original.replace('#define M4', '#define OTHER')],
  ['duplicate macro', original + original.split('\n')[2]],
  ['wrong consumer type', original.replace('va_arg(ap, int)', 'va_arg(ap, unsigned int)')],
  ['missing extraction', original.replace('(uint8_t)(op1 >> 24)', 'changed')],
]) test('rejects ' + name + ' without writing partial changes', () => {
  const path = fixture(source)
  assert.throws(() => stageOpcodePatterns(path), /Unexpected/)
  assert.equal(readFileSync(path, 'utf8'), source)
})
test('rejects partially staged source', () => {
  const path = fixture(); stageOpcodePatterns(path)
  const source = readFileSync(path, 'utf8').replace('(uint8_t)((uint32_t)op1 >> 24)', '(uint8_t)(op1 >> 24)')
  writeFileSync(path, source)
  assert.throws(() => stageOpcodePatterns(path), /partial/)
  assert.equal(readFileSync(path, 'utf8'), source)
})
