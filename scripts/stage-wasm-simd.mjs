import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

// Preparatory value transport only. This does not accept any SIMD instruction.
// Apply after the other wasm3 stages. Vectors stay in slots, never r0/fp0.
export function stageVectorFoundation(directory) {
  const files = new Map()
  const replace = (name, from, to, count = 1) => {
    const source = files.get(name) ?? readFileSync(join(directory, name), 'utf8')
    if (source.split(from).length !== count + 1) {
      throw Error(`Unexpected vector foundation site (${name}): ${from}`)
    }
    files.set(name, source.split(from).join(to))
  }

  replace('wasm3.h', 'typedef struct M3TaggedValue {', `// Byte storage avoids assuming the host has vector types or 16-byte alignment.
typedef struct M3V128 { uint8_t bytes[16]; } M3V128;

typedef struct M3TaggedValue {`)
  replace('wasm3.h', '    union M3ValueUnion {', '    union M3ValueUnion {\n        M3V128 v128;')
  replace('m3_env.h', '        i64 i64Value;', '        i64 i64Value;\n        M3V128 v128Value;')
  replace('m3_core.c', `u32 SizeOfType (m3type_t i_type)
{
    u8 i_m3Type = BaseTypeOf(i_type);`, `u32 SizeOfType (m3type_t i_type)
{
    u8 i_m3Type = BaseTypeOf(i_type);
    if (i_m3Type == c_m3Type_v128) return sizeof(M3V128);`)
  replace('m3_env.c', `            // v128 is skipped: it parses as a slot but has no operations.
`, '')
  replace('m3_env.c', `                if (t == c_m3Type_v128) {
                    continue;
                }

`, '')
  replace('m3_env.c', `                if (SizeOfType(BaseTypeOf(i_type)) == sizeof(u32)) {`, `                if (BaseTypeOf(i_type) == c_m3Type_v128) {
                    memcpy(o_expressed, stack, sizeof(M3V128));
                } else if (SizeOfType(BaseTypeOf(i_type)) == sizeof(u32)) {`)

  replace('m3_exec.h', 'd_m3Op(CopySlot_32)', `d_m3Op(CopySlot_128)
{
    void *dst = slot_ptr(u8);
    void *src = slot_ptr(u8);
    memmove(dst, src, sizeof(M3V128));
    nextOp();
}

d_m3Op(PreserveCopySlot_128)
{
    void *dst = slot_ptr(u8);
    void *src = slot_ptr(u8);
    void *preserve = slot_ptr(u8);
    M3V128 previous, incoming;
    memcpy(&previous, dst, sizeof(previous));
    memcpy(&incoming, src, sizeof(incoming));
    memcpy(preserve, &previous, sizeof(previous));
    memcpy(dst, &incoming, sizeof(incoming));
    nextOp();
}

d_m3Op(GetGlobal_s128)
{
    void *global = immediate(void*);
    void *dst = slot_ptr(u8);
    memcpy(dst, global, sizeof(M3V128));
    nextOp();
}

d_m3Op(SetGlobal_s128)
{
    void *global = immediate(void*);
    void *src = slot_ptr(u8);
    memcpy(global, src, sizeof(M3V128));
    nextOp();
}

d_m3Op(Select_v128)
{
    u32 condition = slot(u32);
    void *second = slot_ptr(u8);
    void *first = slot_ptr(u8);
    void *dst = slot_ptr(u8);
    memmove(dst, condition ? first : second, sizeof(M3V128));
    nextOp();
}

d_m3Op(CopySlot_32)`)
  replace('m3_compile.c', 'Is64BitType(type) ? op_CopySlot_64 : op_CopySlot_32',
    'BaseTypeOf(type) == c_m3Type_v128 ? op_CopySlot_128 : Is64BitType(type) ? op_CopySlot_64 : op_CopySlot_32', 2)
  replace('m3_compile.c', 'Is64BitType(type) ? op_PreserveCopySlot_64 : op_PreserveCopySlot_32',
    'BaseTypeOf(type) == c_m3Type_v128 ? op_PreserveCopySlot_128 : Is64BitType(type) ? op_PreserveCopySlot_64 : op_PreserveCopySlot_32')
  replace('m3_compile.c', 'Is64BitType(i_global->type) ? op_GetGlobal_s64 : op_GetGlobal_s32',
    'BaseTypeOf(i_global->type) == c_m3Type_v128 ? op_GetGlobal_s128 : Is64BitType(i_global->type) ? op_GetGlobal_s64 : op_GetGlobal_s32')
  replace('m3_compile.c', 'Is64BitType(type) ? op_SetGlobal_s64 : op_SetGlobal_s32',
    'BaseTypeOf(type) == c_m3Type_v128 ? op_SetGlobal_s128 : Is64BitType(type) ? op_SetGlobal_s64 : op_SetGlobal_s32')
  replace('m3_compile.c', `M3Result PushRegister (IM3Compilation o, m3type_t i_type)
{`, `M3Result PushRegister (IM3Compilation o, m3type_t i_type)
{
    if (BaseTypeOf(i_type) == c_m3Type_v128) return m3Err_unknownOpcode;`)

  // Endpoint-only checks were sufficient for one/two slots, not four.
  replace('m3_compile.c', `        if (i + searchOffset < d_m3MaxFunctionSlots and o->m3Slots[i] == 0 and o->m3Slots[i + searchOffset] == 0) {`, `        bool available = i + searchOffset < d_m3MaxFunctionSlots;
        for (u16 s = 0; available and s < numSlots; ++s) {
            available = o->m3Slots[i + s] == 0;
        }
        if (available) {`)
  // Stage the entire tuple before writing any destinations. A vector destination
  // can overlap several later scalar sources, unlike the old single-collision
  // recursive algorithm. Compiler stack bookkeeping remains unchanged.
  {
    const name='m3_compile.c',source=files.get(name)??readFileSync(join(directory,name),'utf8')
    const start=source.indexOf('M3Result CopyStackSlotsR ('),end=source.indexOf('\n}\n',start)+3
    if(start<0||end<3)throw Error('Missing tuple copy function')
    const scalar=source.slice(start,end).replaceAll('CopyStackSlotsR','CopyScalarStackSlotsR')
    files.set(name,source.slice(0,start)+scalar+`\nstatic
M3Result CopyStackSlotsR (IM3Compilation o, u16 i_targetSlotStackIndex, u16 i_stackIndex, u16 i_endStackIndex, u16 i_tempSlot)
{
    M3Result result = m3Err_none;
    bool vector = false;
    for (u16 index = i_stackIndex; index < i_endStackIndex; ++index)
        vector |= BaseTypeOf(GetStackTypeFromBottom(o, index)) == c_m3Type_v128;
    if (not vector) return CopyScalarStackSlotsR(o, i_targetSlotStackIndex, i_stackIndex, i_endStackIndex, i_tempSlot);
    u16 scratch = i_tempSlot;
    for (u16 index = i_stackIndex; index < i_endStackIndex; ++index) {
        m3type_t type = GetStackTypeFromBottom(o, index);
        AlignSlotToType(&scratch, type);
        u16 count = GetTypeNumSlots(type);
        _throwif(m3Err_functionStackOverflow, (u32)scratch + count > d_m3MaxFunctionSlots);
_       (CopyStackIndexToSlot(o, scratch, index));
        scratch += count;
        TouchSlot(o, scratch - 1);
    }
    scratch = i_tempSlot;
    for (u16 index = i_stackIndex; index < i_endStackIndex; ++index) {
        m3type_t type = GetStackTypeFromBottom(o, index);
        AlignSlotToType(&scratch, type);
        u16 destination = GetSlotForStackIndex(o, i_targetSlotStackIndex + index - i_stackIndex);
        u16 previous = o->wasmStack[index];
        o->wasmStack[index] = scratch;
        result = CopyStackIndexToSlot(o, destination, index);
        o->wasmStack[index] = previous;
        if (result) goto _catch;
        scratch += GetTypeNumSlots(type);
    }
    _catch: return result;
}
`+source.slice(end))
  }

  const selectAnchor = `    m3type_t type = GetStackTypeFromTop(o, 1); // get type of selection
`
  replace('m3_compile.c', selectAnchor, selectAnchor + `
    if (BaseTypeOf(type) == c_m3Type_v128 and not IsStackPolymorphic(o)) {
        _throwif(m3Err_typeMismatch, GetStackTypeFromTop(o, 0) != c_m3Type_i32 or
                                   GetStackTypeFromTop(o, 2) != c_m3Type_v128);
        // Preserve only the scalar selector register, vector operands are slots.
_       (PreserveRegisters(o));
        for (u16 i = 0; i < 3; ++i) {
            slots[i] = GetStackTopSlotNumber(o);
_           (Pop(o));
        }
_       (EmitOp(o, op_Select_v128));
        for (u16 i = 0; i < 3; ++i) EmitSlotOffset(o, slots[i]);
_       (PushAllocatedSlotAndEmit(o, c_m3Type_v128));
        return result;
    }
`)

  // Scalar call slots stay eight bytes. Vector slots take sixteen, packed on
  // eight-byte boundaries and accessed with memcpy rather than aligned loads.
  replace('m3_compile.c', 'static inline\nvoid AlignSlotToType', `static inline
u16 GetIOSlots(m3type_t type)
{
    return BaseTypeOf(type) == c_m3Type_v128 ? sizeof(M3V128) / sizeof(m3slot_t) : c_ioSlotCount;
}

static u32 GetFuncIOSlots(IM3FuncType type, bool params)
{
    u32 slots = 0;
    u16 count = params ? GetFuncTypeNumParams(type) : GetFuncTypeNumResults(type);
    for (u16 i = 0; i < count; ++i)
        slots += GetIOSlots(params ? GetFuncTypeParamType(type, i) : GetFuncTypeResultType(type, i));
    return slots;
}

static inline
void AlignSlotToType`)
  replace('m3_compile.c', '        u16 returnSlot = numReturns * c_ioSlotCount;',
    '        u32 returnSlot = GetFuncIOSlots(i_functionBlock->type, false);\n        _throwif(m3Err_functionStackOverflow, returnSlot > d_m3MaxFunctionSlots);')
  replace('m3_compile.c', '                returnSlot -= c_ioSlotCount;',
    '                returnSlot -= GetIOSlots(returnType);')
  replace('m3_compile.c', '    u16 argTop = topSlot + (numArgs + numRets) * c_ioSlotCount;', `    u32 argEnd = (u32)topSlot + GetFuncIOSlots(i_type, true) + GetFuncIOSlots(i_type, false);
    _throwif(m3Err_functionStackOverflow, argEnd > d_m3MaxFunctionSlots);
    u16 argTop = (u16)argEnd;`)
  replace('m3_compile.c', '_       (CopyStackTopToSlot(o, argTop -= c_ioSlotCount));',
    '_       (CopyStackTopToSlot(o, argTop -= GetIOSlots(GetFuncTypeParamType(i_type, numArgs))));', 2)
  replace('m3_compile.c', '        topSlot += c_ioSlotCount;', '        topSlot += GetIOSlots(type);')
  replace('m3_compile.c', '    u16 numArgSlots = numArgs * c_ioSlotCount;', `    u32 argSlots = GetFuncIOSlots(i_type, true);
    _throwif(m3Err_functionStackOverflow, (u32)topSlot + argSlots > d_m3MaxFunctionSlots);
    u16 numArgSlots = (u16)argSlots;`)
  replace('m3_compile.c', '    u16 numRetSlots = GetFuncTypeNumResults(i_resultType) * c_ioSlotCount;', `    u32 resultSlots = GetFuncIOSlots(i_resultType, false);
    _throwif(m3Err_functionStackOverflow, resultSlots > d_m3MaxFunctionSlots);
    u16 numRetSlots = (u16)resultSlots;`)
  replace('m3_compile.c', '    u16 numRetSlots = GetFunctionNumReturns(o->function) * c_ioSlotCount;', `    u32 resultSlots = GetFuncIOSlots(funcType, false);
    _throwif(m3Err_functionStackOverflow,
             resultSlots + GetFuncIOSlots(funcType, true) > d_m3MaxFunctionSlots);
    u16 numRetSlots = (u16)resultSlots;`)
  replace('m3_compile.c', `_       (PushAllocatedSlot(o, type));

        // prevent allocator fill-in
        o->slotFirstDynamicIndex += c_ioSlotCount;`, `_       (Push(o, type, o->slotFirstDynamicIndex));
_       (MarkSlotsAllocatedByType(o, o->slotFirstDynamicIndex, type));

        // Match packed call-site offsets, including vectors after scalar args.
        o->slotFirstDynamicIndex += GetIOSlots(type);`)

  // Validate every replacement before writing any staged file.
  for (const [name, source] of files) writeFileSync(join(directory, name), source)
}
