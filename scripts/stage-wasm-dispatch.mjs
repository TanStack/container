import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

// Candidate-only instruction trampoline. Function and structured-loop frames
// retain Wasm3's existing native-depth checks; instructions no longer recurse.
export function stageWasmDispatch(directory,batch=1,unwind=false,loops=false){
  if(![1,8,16,32].includes(batch)||batch>16&&!unwind)throw Error('Unsupported WASM dispatch batch')
  const edit=(file,from,to)=>{
    const path=join(directory,file),source=readFileSync(path,'utf8')
    if(source.split(from).length!==2)throw Error('Unexpected dispatch source: '+file)
    writeFileSync(path,source.replace(from,to))
  }
  edit('m3_env.h','typedef struct M3Runtime {','typedef struct M3Runtime {\n    void* cooperativeDispatch;'+(loops?'\n    unsigned cooperativeLoopDepth;':''))
  edit('m3_env.c','RunCode(m3code, stack, NULL, d_m3OpDefaultArgs, d_m3BaseCstr)','RunCode(m3code, stack, &expressionMemory, d_m3OpDefaultArgs, d_m3BaseCstr)')
  edit('m3_env.c','RunCode(m3code, stack, NULL, d_m3OpDefaultArgs)','RunCode(m3code, stack, &expressionMemory, d_m3OpDefaultArgs)')
  edit('m3_env.c','        if (not result) {\n#if (d_m3EnableOpProfiling || d_m3EnableOpTracing)\n            m3ret_t r = RunCode(m3code',
    '        if (not result) {\n            M3MemoryHeader expressionMemory = {0};\n            expressionMemory.runtime = &runtime;\n#if (d_m3EnableOpProfiling || d_m3EnableOpTracing)\n            m3ret_t r = RunCode(m3code')
  const env=join(directory,'m3_env.c')
  writeFileSync(env,readFileSync(env,'utf8')+'\nvoid* m3_CooperativeFrame(IM3Runtime runtime) { return runtime->cooperativeDispatch; }\nvoid m3_SetCooperativeFrame(IM3Runtime runtime, void* frame) { runtime->cooperativeDispatch = frame; }\n')
  if(loops)writeFileSync(env,readFileSync(env,'utf8')+'\nunsigned* m3_LoopDepth(IM3Runtime runtime) { return &runtime->cooperativeLoopDepth; }\nM3MemoryHeader* m3_LoopMemory(void* memory) { return ((IM3Memory)memory)->mallocated; }\n')
  const file=join(directory,'m3_exec_defs.h'),source=readFileSync(file,'utf8')
  const start=source.indexOf('#define nextOpDirect()')
  const end=source.indexOf('\nd_m3EndExternC',start)
  if(start<0||end<0)throw Error('Missing dispatch definitions')
  writeFileSync(file,source.slice(0,start)+`
#if d_m3EnableOpProfiling || d_m3EnableOpTracing || !d_m3HasFloat
#error Cooperative dispatch requires normal floating-point operation signatures
#endif
${loops?`typedef struct M3LoopContinuation {
    struct M3LoopContinuation* previous;
    pc_t pc;
    m3stack_t sp;
    void* memory;
} M3LoopContinuation;`:''}
typedef struct M3CooperativeDispatch {
    pc_t pc;
    m3stack_t sp;
    M3MemoryHeader* mem;
    m3reg_t r0;
    f64 fp0;
    unsigned remaining;
    ${loops?'M3LoopContinuation* loops;':''}
} M3CooperativeDispatch;

d_m3RetSig RunCode(d_m3OpSig);
void* m3_CooperativeFrame(struct M3Runtime* runtime);
void m3_SetCooperativeFrame(struct M3Runtime* runtime, void* frame);
static inline m3ret_t ScheduleOperation(d_m3OpSig) {
    M3CooperativeDispatch* frame = (M3CooperativeDispatch*)m3_CooperativeFrame(m3MemRuntime(_mem));
    ${batch>1?`if (frame->remaining) {
        frame->remaining--;
        return ((IM3Operation)*_pc)(_pc + 1, d_m3OpArgs);
    }`:''}
    frame->pc = _pc; frame->sp = _sp; frame->mem = _mem;
    frame->r0 = _r0; frame->fp0 = _fp0;
    return (m3ret_t)frame;
}
${unwind?`static inline m3ret_t UnwindInstructionBatch(d_m3OpSig) {
    M3CooperativeDispatch* frame = (M3CooperativeDispatch*)m3_CooperativeFrame(m3MemRuntime(_mem));
    if (frame->remaining == ${batch-1}) return NULL;
    frame->pc = _pc - 1; frame->sp = _sp; frame->mem = _mem;
    frame->r0 = _r0; frame->fp0 = _fp0;
    return (m3ret_t)frame;
}`:''}
${loops?`unsigned* m3_LoopDepth(IM3Runtime runtime);
M3MemoryHeader* m3_LoopMemory(void* memory);
static inline m3ret_t ScheduleLoop(d_m3OpSig) {
    IM3Runtime runtime = m3MemRuntime(_mem);
    M3CooperativeDispatch* frame = (M3CooperativeDispatch*)m3_CooperativeFrame(runtime);
    if (*m3_LoopDepth(runtime) >= 4096) return m3Err_trapStackOverflow;
    M3LoopContinuation* loop = m3_AllocStruct(M3LoopContinuation);
    if (!loop) return m3Err_mallocFailed;
    loop->previous = frame->loops; loop->pc = _pc; loop->sp = _sp;
    loop->memory = m3MemInfo(_mem); frame->loops = loop;
    (*m3_LoopDepth(runtime))++;
    frame->pc = _pc; frame->sp = _sp; frame->mem = _mem;
    frame->r0 = 0; frame->fp0 = 0;
    return (m3ret_t)frame;
}`:''}
#undef nextOpImpl
#undef jumpOpImpl
#define nextOpImpl() RunCode(_pc, d_m3OpArgs)
#define jumpOpImpl(PC) RunCode((pc_t)(PC), d_m3OpArgs)
#define nextOpDirect() return ScheduleOperation(_pc, d_m3OpArgs)
#define jumpOpDirect(PC) return ScheduleOperation((pc_t)(PC), d_m3OpArgs)

d_m3RetSig RunCode(d_m3OpSig) {
    IM3Runtime runtime = m3MemRuntime(_mem);
    void* previous = m3_CooperativeFrame(runtime);
    M3CooperativeDispatch frame = {_pc, _sp, _mem, _r0, _fp0, 0};
    m3_SetCooperativeFrame(runtime, &frame);
    m3ret_t result;
    do {
        frame.remaining = ${batch-1};
        IM3Operation operation = (IM3Operation)*frame.pc;
        result = operation(frame.pc + 1, frame.sp, frame.mem, frame.r0, frame.fp0);
        ${loops?`while (result != (m3ret_t)&frame && frame.loops) {
            M3LoopContinuation* loop = frame.loops;
            if (result == (m3ret_t)loop->pc) {
                frame.pc = loop->pc; frame.sp = loop->sp;
                frame.mem = m3_LoopMemory(loop->memory);
                frame.r0 = 0; frame.fp0 = 0;
                result = (m3ret_t)&frame;
                break;
            }
            frame.loops = loop->previous;
            (*m3_LoopDepth(runtime))--;
            m3_Free(loop);
        }`:''}
    } while (result == (m3ret_t)&frame);
    m3_SetCooperativeFrame(runtime, previous);
    return result;
}
`+source.slice(end))
  edit('m3_exec.h','    nextOpDirect();\n}\n\n#define d_m3CommutativeOpMacro','    return RunCode(d_m3OpAllArgs);\n}\n\n#define d_m3CommutativeOpMacro')
  if(unwind)for(const op of ['Call','CallRef','CallIndirect','Loop','TryTable']){
    edit('m3_exec.h',`d_m3Op(${op})\n{`,`d_m3Op(${op})\n{\n    m3ret_t unwindBatch = UnwindInstructionBatch(d_m3OpAllArgs);\n    if (unwindBatch) return unwindBatch;`)
  }
  if(loops){
    const path=join(directory,'m3_exec.h'),source=readFileSync(path,'utf8')
    const start=source.indexOf('d_m3Op(Loop)\n{'),end=source.indexOf('\n#if d_m3HasExceptionHandling',start)
    if(start<0||end<0)throw Error('Missing loop operation')
    writeFileSync(path,source.slice(0,start)+'d_m3Op(Loop)\n{\n    return ScheduleLoop(d_m3OpAllArgs);\n}\n\n'+source.slice(end))
  }
}
