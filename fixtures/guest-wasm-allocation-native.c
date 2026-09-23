#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
extern int QJS_InstallWasm(JSContext *ctx);
static unsigned forced_collections;
static JSValue collect(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;(void)argc;(void)argv;
    forced_collections++;JS_RunGC(JS_GetRuntime(ctx));return JS_UNDEFINED;
}
static void *read_bytes(const char *path, size_t *size) {
    FILE *f=fopen(path,"rb"); if(!f) exit(2);
    fseek(f,0,SEEK_END);long length=ftell(f);rewind(f);
    if(length<1||length>1024*1024)exit(2);
    char *data=malloc((size_t)length+1);if(!data)exit(2);
    if(fread(data,1,(size_t)length,f)!=(size_t)length)exit(2);
    fclose(f);data[length]=0;*size=length;return data;
}
static void evaluate(JSContext *ctx,const char *source) {
    JSValue value=JS_Eval(ctx,source,strlen(source),"probe.js",0);
    if(JS_IsException(value)){JSValue error=JS_GetException(ctx);JS_SetMemoryLimit(JS_GetRuntime(ctx),64*1024*1024);const char *text=JS_ToCString(ctx,error);JSValue stack=JS_GetPropertyStr(ctx,error,"stack");const char *trace=JS_ToCString(ctx,stack);JSValue g=JS_GetGlobalObject(ctx),name=JS_GetPropertyStr(ctx,g,"currentCase");const char *test=JS_ToCString(ctx,name);JSMemoryUsage usage;JS_ComputeMemoryUsage(JS_GetRuntime(ctx),&usage);fprintf(stderr,"evaluate %.80s, case %s, allocations %lld: %s\n%s\n",source,test,(long long)usage.malloc_size,text,trace);exit(2);}
    JS_FreeValue(ctx,value);
}
int main(int argc,char **argv) {
    if(argc!=11)return 2;
    size_t boot_length,wasm_length,callback_length,memory_length,block_length,else_length,global_length,regression_length,table_length,table_import_length;
    char *boot=read_bytes(argv[1],&boot_length);unsigned char *wasm=read_bytes(argv[2],&wasm_length);
    unsigned char *callback=read_bytes(argv[3],&callback_length),*memory=read_bytes(argv[4],&memory_length);
    unsigned char *blocks=read_bytes(argv[5],&block_length),*elses=read_bytes(argv[6],&else_length),*globals=read_bytes(argv[7],&global_length);char *regressions=read_bytes(argv[8],&regression_length);
    unsigned char *tables=read_bytes(argv[9],&table_length),*table_import=read_bytes(argv[10],&table_import_length);
    const char *setup[]={"function attempt(){return new WebAssembly.Module(bytes)}",
      "const m=new WebAssembly.Module(bytes);function attempt(){return new WebAssembly.Instance(m)}",
      "const i=new WebAssembly.Instance(new WebAssembly.Module(bytes));function attempt(){return i.exports.memory.buffer}",
      "const i=new WebAssembly.Instance(new WebAssembly.Module(bytes));const old=i.exports.memory.buffer;function attempt(){return i.exports.memory.grow(1)}",
      "const m=new WebAssembly.Module(callbackBytes);function attempt(){return new WebAssembly.Instance(m,{host:{callback:n=>n}})}",
      "const i=new WebAssembly.Instance(new WebAssembly.Module(callbackBytes),{host:{callback:()=>new Array(512).fill(1).length}});function attempt(){return i.exports.call(3)}",
      "function attempt(){return new WebAssembly.Memory({initial:1,maximum:8})}",
      "const m=new WebAssembly.Module(memoryBytes),memory=new WebAssembly.Memory({initial:1,maximum:8});new Uint8Array(memory.buffer)[0]=23;function attempt(){return new WebAssembly.Instance(m,{host:{memory,callback:n=>n}})}",
      "const m=new WebAssembly.Module(memoryBytes),memory=new WebAssembly.Memory({initial:1,maximum:8}),i=new WebAssembly.Instance(m,{host:{memory,callback:n=>n}});new Uint8Array(memory.buffer)[0]=23;globalThis.old=memory.buffer;function attempt(){return memory.grow(1)}",
      "function attempt(){return new WebAssembly.Module(blockBytes)}",
      "function attempt(){return new WebAssembly.Module(elseBytes)}",
      "function attempt(){return new WebAssembly.Global({value:'i64',mutable:true},9007199254740995n)}",
      "const m=new WebAssembly.Module(globalBytes),global=new WebAssembly.Global({value:'i32',mutable:true},17);function attempt(){return new WebAssembly.Instance(m,{host:{value:global,constant:23,long:1n}})}",
      "const global=new WebAssembly.Global({value:'i64',mutable:true},9007199254740995n);function attempt(){return global.value}",
      "const global=new WebAssembly.Global({value:'i32',mutable:true},17);function attempt(){global.value={valueOf(){return new Array(512).fill(1).length}};return global.value}",
      "function attempt(){return new WebAssembly.Table({element:'anyfunc',initial:4096,maximum:8192})}",
      "const m=new WebAssembly.Module(tableBytes);function attempt(){return new WebAssembly.Instance(m,{host:{callback:n=>n}})}",
      "const m=new WebAssembly.Module(tableImportBytes),source=new WebAssembly.Instance(new WebAssembly.Module(tableBytes),{host:{callback:n=>n}}).exports,table=source.table;function attempt(){return new WebAssembly.Instance(m,{host:{table}})}",
      "const source=new WebAssembly.Instance(new WebAssembly.Module(tableBytes),{host:{callback:n=>n}}).exports,table=source.table;function attempt(){return table.get(0)}",
      "const source=new WebAssembly.Instance(new WebAssembly.Module(tableBytes),{host:{callback:n=>n}}).exports,table=new WebAssembly.Table({element:'anyfunc',initial:2,maximum:8192},source.read);function attempt(){return table.grow(4096,source.double)}",
      "const source=new WebAssembly.Instance(new WebAssembly.Module(tableBytes),{host:{callback:n=>n}}).exports,table=source.table;function attempt(){table.set(0,source.double);return table.get(0)}"};
    unsigned failures=0,successes=0;
    for(unsigned phase=0;phase<sizeof(setup)/sizeof(setup[0]);phase++)for(int extra=0;extra<=512*1024;extra+=2048){
      fprintf(stderr,"case %d %d\n",phase,extra);
      JSRuntime *rt=JS_NewRuntime();JS_SetMaxStackSize(rt,512*1024);JSContext *ctx=JS_NewContext(rt);
      if(!ctx||QJS_InstallWasm(ctx))return 2;
      evaluate(ctx,boot);
      JSValue global=JS_GetGlobalObject(ctx);
      JS_SetPropertyStr(ctx,global,"bytes",JS_NewArrayBufferCopy(ctx,wasm,wasm_length));
      JS_SetPropertyStr(ctx,global,"callbackBytes",JS_NewArrayBufferCopy(ctx,callback,callback_length));
      JS_SetPropertyStr(ctx,global,"memoryBytes",JS_NewArrayBufferCopy(ctx,memory,memory_length));
      JS_SetPropertyStr(ctx,global,"blockBytes",JS_NewArrayBufferCopy(ctx,blocks,block_length));
      JS_SetPropertyStr(ctx,global,"elseBytes",JS_NewArrayBufferCopy(ctx,elses,else_length));
      JS_SetPropertyStr(ctx,global,"globalBytes",JS_NewArrayBufferCopy(ctx,globals,global_length));
      JS_SetPropertyStr(ctx,global,"tableBytes",JS_NewArrayBufferCopy(ctx,tables,table_length));
      JS_SetPropertyStr(ctx,global,"tableImportBytes",JS_NewArrayBufferCopy(ctx,table_import,table_import_length));
      evaluate(ctx,setup[phase]);JSValue fn=JS_GetPropertyStr(ctx,global,"attempt");
      JSMemoryUsage usage;JS_ComputeMemoryUsage(rt,&usage);JS_SetMemoryLimit(rt,usage.malloc_size+extra);
      JSValue value=JS_Call(ctx,fn,JS_UNDEFINED,0,NULL);JS_SetMemoryLimit(rt,16*1024*1024);
      int failed=JS_IsException(value);
      if(failed){failures++;JS_FreeValue(ctx,JS_GetException(ctx));}else successes++;
      JS_FreeValue(ctx,value);
      evaluate(ctx,"if(new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.answer()!==42)throw Error('recovery')");
      if(phase==7||phase==8)evaluate(ctx,"if(new WebAssembly.Instance(m,{host:{memory,callback:n=>n}}).exports.read(0)!==23)throw Error('shared memory recovery');memory.grow(0)");
      if(phase==12)evaluate(ctx,"if(new WebAssembly.Instance(m,{host:{value:global,constant:23,long:1n}}).exports.read()!==17)throw Error('global recovery')");
      if(phase==14)evaluate(ctx,failed?"if(global.value!==17)throw Error('partial global write')":"if(global.value!==512)throw Error('global write')");
      if(phase==17)evaluate(ctx,"if(new WebAssembly.Instance(m,{host:{table}}).exports.call(0,25)!==42)throw Error('table recovery')");
      if(phase==19)evaluate(ctx,failed?"if(table.length!==2||table.get(0)(25)!==42)throw Error('partial table growth')":"if(table.length!==4098||table.get(0)(25)!==42)throw Error('table growth')");
      if(phase==20)evaluate(ctx,"if(table.get(0)!==source.read&&table.get(0)!==source.double)throw Error('lost table entry');table.set(0,source.read);if(table.get(0)(25)!==42)throw Error('table set recovery')");
      JS_FreeValue(ctx,fn);JS_FreeValue(ctx,global);JS_FreeContext(ctx);JS_FreeRuntime(rt);
    }
    JSRuntime *rt=JS_NewRuntime();JS_SetMemoryLimit(rt,16*1024*1024);JS_SetMaxStackSize(rt,512*1024);JSContext *ctx=JS_NewContext(rt);
    if(!ctx||QJS_InstallWasm(ctx))return 2;
    evaluate(ctx,boot);
    JSValue global=JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx,global,"collectDuringCallback",JS_NewCFunction(ctx,collect,"collectDuringCallback",0));
    JS_FreeValue(ctx,global);
    int64_t baseline=0,maximum=0;
    for(int round=0;round<20;round++){
      fprintf(stderr,"GC round %d\n",round);
      evaluate(ctx,regressions);JS_RunGC(rt);
      evaluate(ctx,"if(survivingTable.get(0)(25)!==42||survivingTableCall(0,25)!==42)throw Error('table outlived owner');survivingTable=null;survivingTableCall=null");
      evaluate(ctx,"savedReference.restore(0);if(savedReference.call(0,25)!==42)throw Error('reference global outlived table');savedReference.dropSaved();savedReference=null");
      evaluate(ctx,"if(survivingGlobalRead()!==37)throw Error('global outlived owner');survivingGlobal.value=41;if(survivingGlobalRead()!==41)throw Error('shared global outlived owner');survivingGlobal=null;survivingGlobalRead=null");
      evaluate(ctx,"for(const g of retainedGlobals)if(g.value!==7)throw Error('retained global');retainedGlobals=null");
      evaluate(ctx,"if(survivingRead(0)!==57||survivingMemory.grow(1)!==1||survivingRead(0)!==57)throw Error('memory outlived owner');survivingMemory=null;survivingRead=null");
      evaluate(ctx,"for(const b of retainedBuffers)if(new Uint8Array(b)[0]!==17)throw Error('retained buffer');retainedBuffers=null");JS_RunGC(rt);
      JSMemoryUsage usage;JS_ComputeMemoryUsage(rt,&usage);
      if(round==1)baseline=usage.malloc_size;
      if(round>=1&&usage.malloc_size>maximum)maximum=usage.malloc_size;
      if(round>1&&usage.malloc_size>baseline+4096){fprintf(stderr,"retained allocations grew: %lld -> %lld\n",(long long)baseline,(long long)usage.malloc_size);return 1;}
    }
    JS_FreeContext(ctx);JS_FreeRuntime(rt);
    free(boot);free(wasm);free(callback);free(memory);free(blocks);free(elses);free(globals);free(regressions);free(tables);free(table_import);printf("{\"failures\":%u,\"successes\":%u,\"gcRounds\":20,\"forcedCallbackCollections\":%u,\"retainedBaseline\":%lld,\"retainedMaximum\":%lld}\n",failures,successes,forced_collections,(long long)baseline,(long long)maximum);return failures&&successes&&forced_collections==20?0:1;
}
