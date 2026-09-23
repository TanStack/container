import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

// Candidate-only counters. No addresses, timing, limits or allocation changes.
// Run after shared-storage and memory-addressing stages on private staged files.
export function stageWasmMemoryDiagnostics({guestWasmFile,sharedStorageFile,wasm3Directory}){
  const files=new Map()
  const edit=(path,from,to)=>{
    const text=files.get(path)??readFileSync(path,'utf8')
    if(text.split(from).length!==2)throw Error('Unexpected memory diagnostic anchor: '+path+' '+from)
    files.set(path,text.replace(from,to))
  }
  edit(guestWasmFile,'#ifdef QTS_SHARED_STORAGE\nM3Result qwasm_shared_resize',`static double qwasm_memory_diagnostics[8];
/* fields: opcode attempts, opcode failures, shared resize attempts,
   shared resize failures, shared budget failures, shared allocation failures,
   last current pages, last requested pages. */
void QWasm_MemoryDiagnosticCount(int field) {
    if(field>=0&&field<6)qwasm_memory_diagnostics[field]++;
}
void QWasm_MemoryDiagnosticPages(double current,double requested) {
    qwasm_memory_diagnostics[6]=current;qwasm_memory_diagnostics[7]=requested;
}
double QWasm_MemoryDiagnosticGet(int field) {
    return field>=0&&field<8?qwasm_memory_diagnostics[field]:-1;
}
static JSValue qwasm_memory_diagnostic_snapshot(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv) {
    (void)self;(void)argc;(void)argv;
    JSValue values=JS_NewArray(ctx);
    if(JS_IsException(values))return values;
    for(uint32_t i=0;i<8;i++){
        if(JS_SetPropertyUint32(ctx,values,i,JS_NewFloat64(ctx,qwasm_memory_diagnostics[i]))<0){JS_FreeValue(ctx,values);return JS_EXCEPTION;}
    }
    return values;
}
#ifdef QTS_SHARED_STORAGE
M3Result qwasm_shared_resize`)
  edit(guestWasmFile,'    int result = JS_SetPropertyStr(ctx, global, "__nativeWasm", JS_NewCFunction(ctx, dispatch, "nativeWasm", 4));',`    int result = JS_SetPropertyStr(ctx, global, "__qjsWasmMemoryDiagnostics", JS_NewCFunction(ctx, qwasm_memory_diagnostic_snapshot, "wasmMemoryDiagnostics", 0));
    if(result<0){JS_FreeValue(ctx,global);return result;}
    result = JS_SetPropertyStr(ctx, global, "__nativeWasm", JS_NewCFunction(ctx, dispatch, "nativeWasm", 4));`)
  edit(guestWasmFile,'M3Result qwasm_shared_resize(IM3Runtime runtime,IM3Memory memory,u64 pages) {',`M3Result qwasm_shared_resize(IM3Runtime runtime,IM3Memory memory,u64 pages) {
    QWasm_MemoryDiagnosticCount(2);
    QWasm_MemoryDiagnosticPages((double)memory->numPages,(double)pages);`)
  for(const message of ['shared memory limits exceeded','shared memory group capacity exceeded']){
    const text=files.get(guestWasmFile)
    const from='return "'+message+'";'
    if(!text.includes(from))throw Error('Missing shared resize error')
    files.set(guestWasmFile,text.split(from).join('{ QWasm_MemoryDiagnosticCount(3); '+from+' }'))
  }
  edit(sharedStorageFile,'int QTS_SharedStorageGrow(QTSSharedStorage *storage,size_t size){',`extern void QWasm_MemoryDiagnosticCount(int);
int QTS_SharedStorageGrow(QTSSharedStorage *storage,size_t size){`)
  edit(sharedStorageFile,'if(qts_shared_bytes>qts_shared_max_bytes||delta>qts_shared_max_bytes-qts_shared_bytes)return 0;',
    'if(qts_shared_bytes>qts_shared_max_bytes||delta>qts_shared_max_bytes-qts_shared_bytes){QWasm_MemoryDiagnosticCount(4);return 0;}')
  edit(sharedStorageFile,'if(qts_shared_bytes>qts_shared_max_bytes||payload>qts_shared_max_bytes-qts_shared_bytes)return 0;',
    'if(qts_shared_bytes>qts_shared_max_bytes||payload>qts_shared_max_bytes-qts_shared_bytes){QWasm_MemoryDiagnosticCount(4);return 0;}')
  edit(sharedStorageFile,'void *next=calloc(1,payload);\n  if(!next&&payload!=exact){payload=exact;next=calloc(1,payload);}\n  if(!next)return 0;',
    'void *next=calloc(1,payload);\n  if(!next&&payload!=exact){payload=exact;next=calloc(1,payload);}\n  if(!next){QWasm_MemoryDiagnosticCount(5);return 0;}')
  const path=join(wasm3Directory,'m3_exec.h')
  let source=readFileSync(path,'utf8')
  for(const name of ['MemGrow','MemGrow64']){
    const anchor='d_m3Op('+name+')\n{',start=source.indexOf(anchor),end=source.indexOf('\n}\n',start)
    if(start<0||end<0)throw Error('Missing memory grow operation '+name)
    let body=source.slice(start,end)
    body=body.replace(anchor,anchor+'\n    QWasm_MemoryDiagnosticCount(0);')
    if(body.split('    nextOp();').length!==2)throw Error('Unexpected memory grow return '+name)
    body=body.replace('    nextOp();','    if (_r0 == (m3reg_t)-1) QWasm_MemoryDiagnosticCount(1);\n    nextOp();')
    source=source.slice(0,start)+body+source.slice(end)
  }
  source='extern void QWasm_MemoryDiagnosticCount(int);\n'+source
  files.set(path,source)
  for(const [path,source] of files)writeFileSync(path,source)
}
