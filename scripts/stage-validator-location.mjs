import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

export function stageValidatorLocation(directory) {
  const replace = (name, from, to) => {
    const path = join(directory, name)
    const source = readFileSync(path, 'utf8')
    if (source.split(from).length !== 2) {
      throw Error('Unexpected validator location site: ' + name)
    }
    writeFileSync(path, source.replace(from, to))
  }

  replace('m3_validate.c', '    IM3Function function;\n', `    IM3Function function;
    bytes_t     opcodeStart;
    m3opcode_t  currentOpcode;
    bool        opcodeValid;
`)
  replace('m3_validate.c', `        m3opcode_t opcode;
        r = Read_opcode(&opcode, &v->wasm, v->wasmEnd);
        if (r) return r;`, `        m3opcode_t opcode;
        v->opcodeValid = false;
        v->opcodeStart = v->wasm;
        r = Read_opcode(&opcode, &v->wasm, v->wasmEnd);
        if (r) return r;
        v->currentOpcode = opcode;
        v->opcodeValid = true;`)
  replace('m3_validate.c', '// ---------- Public entry point ----------', `// The offset includes the code-size and locals prefixes, relative to function->wasm.
int GetValidationLocation(IM3Function function, size_t *offset, u32 *opcode)
{
    if (!function || !function->wasm || !function->module ||
        !function->module->runtime || !offset || !opcode) return 0;
    ValCtx *v = function->module->runtime->validator;
    if (!v || v->function != function || !v->opcodeValid) return 0;
    *offset = (size_t)(v->opcodeStart - function->wasm);
    *opcode = (u32)v->currentOpcode;
    return 1;
}

int GetValidationSubopcode(IM3Function function, u32 *subopcode)
{
    if (!function || !function->module || !function->module->runtime || !subopcode) return 0;
    ValCtx *v = function->module->runtime->validator;
    if (!v || v->function != function || !v->opcodeValid) return 0;
    if (v->currentOpcode != 0xfd && v->currentOpcode != 0xfc && v->currentOpcode != 0xfe) return 0;
    // Decode only the instruction immediate into a local cursor. Diagnostics
    // never change the validator cursor or whether a module is accepted.
    bytes_t cursor = v->opcodeStart + 1;
    u32 value;
    if (ReadLEB_u32(&value, &cursor, v->wasmEnd)) return 0;
    *subopcode = value;
    return 1;
}

// ---------- Public entry point ----------`)
  replace('m3_validate.c', '#else // !d_m3EnableValidation', `#else // !d_m3EnableValidation

int GetValidationLocation(IM3Function function, size_t *offset, u32 *opcode)
{
    (void)function;
    (void)offset;
    (void)opcode;
    return 0;
}
int GetValidationSubopcode(IM3Function function, u32 *subopcode)
{
    (void)function;
    (void)subopcode;
    return 0;
}`)
  replace('m3_validate.h', 'M3Result ValidateFunction (IM3Function i_function);', `M3Result ValidateFunction (IM3Function i_function);
// Offset is relative to function->wasm, including code-size and locals prefixes.
// Returns 0 without modifying outputs when no current opcode is available.
int GetValidationLocation(IM3Function function, size_t *offset, u32 *opcode);
int GetValidationSubopcode(IM3Function function, u32 *subopcode);`)
}
