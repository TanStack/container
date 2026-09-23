import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

// All guest execution in this candidate is serialized by the engine's fiber
// scheduler. Instructions below never yield except the explicit wait bridge.
// This backend is not a pthread implementation for a concurrently accessed heap.
export function stageWasmAtomics(directory){
  const edit=(name,from,to)=>{
    const path=join(directory,name),source=readFileSync(path,'utf8')
    if(source.split(from).length!==2)throw Error('Unexpected WASM atomic integration site: '+name)
    writeFileSync(path,source.replace(from,to))
  }
  writeFileSync(join(directory,'qwasm_atomic_ops.h'),`#ifndef QWASM_ATOMIC_OPS_H
#define QWASM_ATOMIC_OPS_H
/* kind: notify, wait, fence, load, store, add/sub/and/or/xor/xchg/cmpxchg. */
typedef struct { unsigned kind, widthLog2, value64, nargs, result64, hasResult; } QWasmAtomicInfo;
static int qwasm_atomic_info(unsigned sub,QWasmAtomicInfo *out) {
    QWasmAtomicInfo info={0};
    if(sub==0){info.kind=0;info.widthLog2=2;info.nargs=2;info.hasResult=1;}
    else if(sub==1||sub==2){info.kind=1;info.widthLog2=sub==1?2:3;info.value64=sub==2;info.nargs=3;info.hasResult=1;}
    else if(sub==3){info.kind=2;}
    else if(sub>=0x10&&sub<=0x4e){
        static const unsigned widths[7]={2,3,0,1,0,1,2};
        static const unsigned wide[7]={0,1,0,0,1,1,1};
        unsigned group=(sub-0x10)/7,lane=(sub-0x10)%7;
        info.kind=3+group;info.widthLog2=widths[lane];info.value64=wide[lane];
        info.nargs=group==0?1:group==8?3:2;
        info.hasResult=group!=1;info.result64=info.hasResult&&info.value64;
    }else return 0;
    *out=info;return 1;
}
/* Operand widths in pop order. The last operand is always the address. */
static unsigned qwasm_atomic_operand64(QWasmAtomicInfo info,unsigned index,unsigned address64){
    if(index+1==info.nargs)return address64;
    if(info.kind==1&&index==0)return 1;
    return info.value64;
}
#endif
`)
  edit('m3_exec.h','#include <limits.h>','#include <limits.h>\n#include "qwasm_atomic_ops.h"')
  edit('m3_exec.h','d_m3Op(MemSize)',`extern int qwasm_atomic_wait(void *,int,uint64_t,int64_t);
extern int qwasm_atomic_notify(void *,uint32_t);
d_m3Op(QWasmAtomic) {
    u32 sub=immediate(u32),address64=immediate(u32);
    u64 offset=immediate(u32);offset|=(u64)immediate(u32)<<32;
    QWasmAtomicInfo info;u64 args[3]={0};
    if(!qwasm_atomic_info(sub,&info))return m3Err_trapAbort;
    for(unsigned i=0;i<info.nargs;i++)args[i]=d_m3WideOperand(qwasm_atomic_operand64(info,i,address64));
    if(info.kind==2){nextOp();}
    u64 address=args[info.nargs-1];
    if(address>UINT64_MAX-offset)return m3Err_trapOutOfBoundsMemoryAccess;
    address+=offset;
    unsigned width=1u<<info.widthLog2;
    if(!d_m3MemRangeOk(address,width,_mem))return m3Err_trapOutOfBoundsMemoryAccess;
    if(address&(width-1))return "[trap] unaligned atomic memory access";
    u8 *ptr=m3MemData(_mem)+(size_t)address;
    if(info.kind==0){
        _r0=m3MemInfo(_mem)->isShared?qwasm_atomic_notify(ptr,(u32)args[0]):0;
        nextOp();
    }
    if(info.kind==1){
        if(!m3MemInfo(_mem)->isShared)return "[trap] atomic wait on unshared memory";
        int status=qwasm_atomic_wait(ptr,(int)info.widthLog2,args[1],(int64_t)args[0]);
        if(status<0)return m3Err_trapAbort;
        _r0=(u32)status;nextOp();
    }
    /* Bytewise little-endian access keeps narrow operations and wrapping
       arithmetic defined in C, including i64 operations on a wasm32 host. */
    u64 old=0;
    for(unsigned i=0;i<width;i++)old|=(u64)ptr[i]<<(8*i);
    u64 replacement=old,value=args[0];
    switch(info.kind){
      case 3:break;
      case 4:replacement=value;break;
      case 5:replacement=old+value;break;
      case 6:replacement=old-value;break;
      case 7:replacement=old&value;break;
      case 8:replacement=old|value;break;
      case 9:replacement=old^value;break;
      case 10:replacement=value;break;
      case 11:{
        u64 mask=width==8?UINT64_MAX:(((u64)1<<(width*8))-1);
        if(old==(args[1]&mask))replacement=value;
        break;
      }
      default:return m3Err_trapAbort;
    }
    if(info.kind!=3)for(unsigned i=0;i<width;i++)ptr[i]=(u8)(replacement>>(8*i));
    if(info.hasResult)_r0=info.result64?old:(u32)old;
    nextOp();
}

d_m3Op(MemSize)`)
  edit('m3_compile.c','M3Result CompileRawFunction (',`static M3Result Compile_AtomicOpcode(IM3Compilation o,m3opcode_t unused) {
    M3Result result=m3Err_none;
    u32 sub,align=0,memoryIdx=0;u64 offset=0;
    QWasmAtomicInfo info;
    (void)unused;
_   (ReadLEB_u32(&sub,&o->wasm,o->wasmEnd));
    _throwif(m3Err_unknownOpcode,!qwasm_atomic_info(sub,&info));
    if(info.kind==2){
        _throwif(m3Err_wasmMalformed,o->wasm>=o->wasmEnd||*o->wasm++!=0);
    }else{
_       (ReadMemoryArg(&align,&memoryIdx,&offset,&o->wasm,o->wasmEnd));
        _throwif(m3Err_unknownMemory,memoryIdx>=o->module->numMemories);
        _throwif(m3Err_invalidAlignment,align!=info.widthLog2);
        _throwif(m3Err_wasmMalformed,!o->module->memories[memoryIdx]->isMemory64&&offset>0xffffffffull);
    }
    {
        unsigned address64=info.kind!=2&&o->module->memories[memoryIdx]->isMemory64;
        for(unsigned i=0;i<info.nargs;i++){
_           (CheckOperandType(o,i,qwasm_atomic_operand64(info,i,address64)?c_m3Type_i64:c_m3Type_i32));
        }
_       (PreserveRegisterIfOccupied(o,c_m3Type_i64));
        if(memoryIdx){
_           (EmitSetMemory(o,memoryIdx));
        }
_       (EmitOp(o,op_QWasmAtomic));
        EmitConstant32(o,sub);EmitConstant32(o,address64);
        EmitConstant32(o,(u32)offset);EmitConstant32(o,(u32)(offset>>32));
        for(unsigned i=0;i<info.nargs;i++){
            EmitSlotOffset(o,GetStackTopSlotNumber(o));
_           (Pop(o));
        }
        if(info.hasResult){
_           (PushRegister(o,info.result64?c_m3Type_i64:c_m3Type_i32));
        }
        if(memoryIdx){
_           (EmitSetMemory(o,0));
        }
    }
    _catch:return result;
}

M3Result CompileRawFunction (`)
  edit('m3_compile.c','    _( Compile_ExtendedOpcode )         \\', '    _( Compile_ExtendedOpcode )         \\\n    _( Compile_AtomicOpcode )           \\')
  edit('m3_compile.c','    c_opHigh_extended   // always present, so the enum is never empty','    c_opHigh_atomic,\n    c_opHigh_extended   // always present, so the enum is never empty')
  edit('m3_compile.c','    M3OP( "0xFC",','    M3OP( "0xFE", 0, c_m3Type_unknown, d_cc(Compile_AtomicOpcode), d_emptyOpList ),\n    M3OP( "0xFC",')
  edit('m3_compile.c','    case c_waOp_extended: return c_opHigh_extended;','    case 0xfe: return c_opHigh_atomic;\n    case c_waOp_extended: return c_opHigh_extended;')
  edit('m3_validate.c','#include "m3_info.h"','#include "m3_info.h"\n#include "qwasm_atomic_ops.h"')
  edit('m3_validate.c','        case 0xfc:',`        case 0xfe: {
            u32 sub,align,memidx;u64 offset;QWasmAtomicInfo info;
            r=ReadLEB_u32(&sub,&v->wasm,v->wasmEnd);if(r)return r;
            if(!qwasm_atomic_info(sub,&info))return m3Err_unknownOpcode;
            if(info.kind==2){
                if(v->wasm>=v->wasmEnd||*v->wasm++!=0)return m3Err_wasmMalformed;
                break;
            }
            r=ReadMemoryArg(&align,&memidx,&offset,&v->wasm,v->wasmEnd);if(r)return r;
            if(align!=info.widthLog2)return m3Err_invalidAlignment;
            if(!v_has_memory_idx(v,memidx))return m3Err_unknownMemory;
            if(!v_offset_in_range(v,memidx,offset))return m3Err_wasmMalformed;
            unsigned address64=v_memory_addrtype(v,memidx)==c_m3Type_i64;
            for(unsigned i=0;i<info.nargs;i++){
                r=v_pop_expect(v,qwasm_atomic_operand64(info,i,address64)?c_m3Type_i64:c_m3Type_i32,&a);if(r)return r;
            }
            if(info.hasResult){r=v_push(v,info.result64?c_m3Type_i64:c_m3Type_i32);if(r)return r;}
            break;
        }
        case 0xfc:`)
}
