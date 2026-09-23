import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

export function stageSharedWasmMemory(directory){
  const edit=(name,from,to)=>{
    const path=join(directory,name),source=readFileSync(path,'utf8')
    if(source.split(from).length!==2)throw Error('Unexpected shared WASM integration site: '+name)
    writeFileSync(path,source.replace(from,to))
  }
  edit('m3_core.h','typedef struct M3MemoryHeader {','typedef struct M3MemoryHeader {\n    void *sharedData; /* separate shared payload; NULL for adjacent ordinary memory */')
  edit('m3_exec_defs.h','#define m3MemData(mem)              (u8*)(((M3MemoryHeader*)(mem))+1)',`static inline u8 *m3SharedMemData(M3MemoryHeader *header) {
    return header->sharedData ? (u8 *)header->sharedData : (u8 *)(header+1);
}
#define m3MemData(mem) m3SharedMemData((M3MemoryHeader *)(mem))`)
  edit('m3_env.c','        memory->mallocated->length  = (size_t)numPageBytes;',
    '        memory->mallocated->sharedData = NULL;\n        memory->mallocated->length  = (size_t)numPageBytes;')
  edit('m3_env.h','    bool isMemory64;     // addressed by i64 rather than i32','    bool isMemory64;     // addressed by i64 rather than i32\n    bool isShared;')
  edit('m3_env.h','    bool             isMemory64;     // addressed by i64 rather than i32','    bool             isMemory64;     // addressed by i64 rather than i32\n    bool             isShared;\n    void *           sharedStorage; /* stable group-owned backing identity */')
  edit('m3_module.c','    memory->isMemory64 = i_info->isMemory64;','    memory->isMemory64 = i_info->isMemory64;\n    memory->isShared = i_info->isShared;')
  edit('m3_exec.h',`    if (numPagesToGrow >= 0) {
        _r0 = (m3reg_t)memory->numPages;

        if (M3_LIKELY(numPagesToGrow)) {`,`    if (numPagesToGrow >= 0) {
        _r0 = (m3reg_t)memory->numPages;

        if (M3_LIKELY(numPagesToGrow) || memory->isShared) {`)
  edit('m3_parse.c','flag & ~0x0Du','flag & ~0x0Fu')
  edit('m3_parse.c','flag & ~0x09u','flag & ~0x0Bu')
  edit('m3_parse.c','    o_memory->isMemory64 = (flag & (1u << 2)) != 0;',`    o_memory->isShared = (flag & 2u) != 0;
    _throwif(m3Err_wasmMalformed, o_memory->isShared && !(flag & 1u));
    o_memory->isMemory64 = (flag & (1u << 2)) != 0;`)
  edit('m3_env.c','M3Result ResizeMemory (IM3Runtime io_runtime, IM3Memory memory, u64 i_numPages)\n{',`extern M3Result qwasm_shared_resize(IM3Runtime, IM3Memory, u64);
M3Result ResizeMemory (IM3Runtime io_runtime, IM3Memory memory, u64 i_numPages)
{
    if (memory->isShared) return qwasm_shared_resize(io_runtime,memory,i_numPages);`)
  edit('m3_env.c','void FreeMemoryBlock (IM3Memory io_memory)\n{',`extern void qwasm_shared_free_block(IM3Memory);
void FreeMemoryBlock (IM3Memory io_memory)
{
    if (io_memory->isShared) { qwasm_shared_free_block(io_memory); return; }`)
}
