import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

export function stageValidatorControl(directory){
  const replace=(name,from,to)=>{
    const path=join(directory,name),source=readFileSync(path,'utf8')
    if(source.split(from).length!==2)throw Error('Unexpected validator control site: '+name)
    writeFileSync(path,source.replace(from,to))
  }
  replace('m3_validate.c','    ValCtrlFrame ctrl [d_m3ValCtrlDepth];\n    u16          ctrlTop;',
    '    ValCtrlFrame *ctrl;\n    u32          ctrlTop;\n    u32          ctrlCapacity;')
  replace('m3_validate.c',`    if (v->ctrlTop >= d_m3ValCtrlDepth)
        return "validator control stack limit exceeded";`, `    if (v->ctrlTop == v->ctrlCapacity) {
        size_t maximum = SIZE_MAX / sizeof(ValCtrlFrame);
        if (maximum > UINT32_MAX) maximum = UINT32_MAX;
        if (v->ctrlCapacity >= maximum) return m3Err_mallocFailed;
        u32 capacity = v->ctrlCapacity ? v->ctrlCapacity : 16;
        capacity = capacity > maximum / 2 ? (u32)maximum : capacity * 2;
        ValCtrlFrame *next = m3_ReallocArray(ValCtrlFrame, v->ctrl, capacity, v->ctrlCapacity);
        if (!next) return m3Err_mallocFailed;
        v->ctrl = next;
        v->ctrlCapacity = capacity;
    }`)
  replace('m3_validate.c','    memset(v, 0, sizeof(*v));',`    ValCtrlFrame *ctrl = v->ctrl;
    u32 capacity = v->ctrlCapacity;
    extern double QWasm_ValidatorResetTimingBegin(void);
    extern void QWasm_ValidatorResetTimingEnd(double, size_t);
    double resetStart = QWasm_ValidatorResetTimingBegin();
    memset(v, 0, sizeof(*v));
    QWasm_ValidatorResetTimingEnd(resetStart, sizeof(*v));
    v->ctrl = ctrl;
    v->ctrlCapacity = capacity;`)
  replace('m3_validate.c','// ---------- Public entry point ----------',`void FreeValidator(ValCtx *v)
{
    if (!v) return;
    m3_Free(v->ctrl);
    m3_Free(v);
}

// ---------- Public entry point ----------`)
  replace('m3_validate.h','M3Result ValidateFunction (IM3Function i_function);',
    'M3Result ValidateFunction (IM3Function i_function);\nvoid FreeValidator(ValCtx *v);')
  replace('m3_env.c','#include "m3_compile.h"','#include "m3_compile.h"\n#include "m3_validate.h"')
  replace('m3_env.c','    m3_Free(i_runtime->validator);','    FreeValidator(i_runtime->validator);\n    i_runtime->validator = NULL;')
  replace('m3_validate.c',`                // Unknown FC sub-opcode: skip validation (allow forward compat)
                break;`, `                // Unsupported instructions cannot establish a valid module.
                return m3Err_wasmMalformed;`)
  replace('m3_validate.c',`            // Unknown opcode - skip rather than fail for forward compat
            // (the compiler will reject truly unsupported ops later)
            break;`, `            // Reject here, even in unreachable code and unused functions.
            // Module construction must not defer validation to instantiation.
            return m3Err_wasmMalformed;`)
  replace('m3_validate.c',`            if (idx >= v->module->numGlobals) return m3Err_unknownGlobal;
            r = v_pop_expect(v, BaseTypeOf(v->module->globals[idx].type), &a);`, `            if (idx >= v->module->numGlobals) return m3Err_unknownGlobal;
            if (!v->module->globals[idx].isMutable) return m3Err_settingImmutableGlobal;
            r = v_pop_expect(v, BaseTypeOf(v->module->globals[idx].type), &a);`)
}
