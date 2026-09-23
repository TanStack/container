import {readFileSync,writeFileSync} from 'node:fs'

const original = '#define M4(op1, op2, op3, op4)  ((op1) | ((op2) << 8) | ((op3) << 16) | ((op4) << 24))'
const replacement = `/* Pack opcode alternatives without signed-shift overflow. */
static inline int code_pattern4(int op1, int op2, int op3, int op4)
{
    uint32_t pattern = (uint32_t)op1 | ((uint32_t)op2 << 8) |
                       ((uint32_t)op3 << 16) | ((uint32_t)op4 << 24);
    /* code_match reads int varargs. Convert the high-bit representation
       without an out-of-range unsigned-to-signed conversion. */
    if (pattern & UINT32_C(0x80000000))
        return (int)(pattern & INT32_MAX) - INT32_MAX - 1;
    return (int)pattern;
}
#define M4(op1, op2, op3, op4)  code_pattern4((op1), (op2), (op3), (op4))`
const shifts = [8,16,24].map(bits => [`(uint8_t)(op1 >> ${bits})`, `(uint8_t)((uint32_t)op1 >> ${bits})`])

/** Preserve code_match's signed int varargs while packing all four opcode bytes. */
export function stageOpcodePatterns(path) {
  let source = readFileSync(path, 'utf8')
  if (source.includes('static inline int code_pattern4(')) {
    if (source.split(replacement).length !== 2 || source.includes(original) || shifts.some(([from,to]) => source.includes(from) || source.split(to).length !== 2)) throw new Error('Unexpected partial opcode pattern stage')
    return
  }
  if (source.split(original).length !== 2 || source.split('static BOOL code_match(CodeContext *s, int pos, ...)').length !== 2 || !source.includes('op1 = va_arg(ap, int);')) throw new Error('Unexpected opcode pattern packing site')
  source = source.replace(original, replacement)
  for (const [from,to] of shifts) {
    if (source.split(from).length !== 2) throw new Error('Unexpected opcode pattern byte extraction site')
    source = source.replace(from, to)
  }
  writeFileSync(path, source)
}
