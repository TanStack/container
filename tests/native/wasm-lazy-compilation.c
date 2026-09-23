#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "m3_env.h"
#include "m3_compile.h"
#include "m3_validate.h"

void *test_real_malloc(size_t);
void *test_real_realloc(void *,size_t,size_t);
void test_real_free(void *);
static size_t allocations,live;
static int fail_copy,fail_page;
static pc_t call_site;
static int call_kind;
void *m3_Malloc_Impl(size_t size){
    allocations++;
    if(fail_page&&size>=32768)return NULL;
    void *p=test_real_malloc(size);if(p)live++;return p;
}
void *m3_Realloc_Impl(void *p,size_t size,size_t old){
    allocations++;
    void *next=test_real_realloc(p,size,old);
    if(next&&!p)live++;
    return next;
}
void m3_Free_Impl(void *p){if(p){assert(live);live--;}test_real_free(p);}
int test_fail_copy(void){return fail_copy;}
void test_record_call(pc_t pc,int kind){call_site=pc;call_kind=kind;}

static void run_case(int tail,int page_failure){
    unsigned char bytes[]={0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,3,2,0,0,5,3,1,0,1,10,11,2,4,0,16,1,11,4,0,65,42,11};
    bytes[30]=tail?18:16;
    IM3Environment env=m3_NewEnvironment();assert(env);
    IM3Runtime rt=m3_NewRuntime(env,65536,NULL);assert(rt);
    IM3Module module=NULL;
    assert(!m3_ParseModule(env,&module,bytes,sizeof(bytes)));
    assert(!m3_LoadModule(rt,module));
    // Preserve the same eager full validation requirement as the candidate.
    for(unsigned i=0;i<module->numFunctions;i++)assert(!ValidateFunction(&module->functions[i]));
    m3_SetValidation(rt,false);
    IM3Function caller=&module->functions[0],callee=&module->functions[1];
    call_site=NULL;
    if(page_failure){
        fail_page=1;
        assert(CompileFunction(callee));
        fail_page=0;
    }else{
        assert(!CompileFunction(caller));
        assert(call_site&&call_kind==(tail?2:1));
        // Save the two typed instruction slots recorded by the compiler hook.
        code_t opcode=call_site[0],operand=call_site[1];
        assert(!callee->compiled);
        fail_copy=1;
        assert(m3_Call(caller,0,NULL));
        fail_copy=0;
        assert(!callee->compiled&&callee->compilationFailed);
        assert(call_site[0]==opcode&&call_site[1]==operand);
        size_t before=allocations;
        assert(m3_Call(caller,0,NULL));
        assert(allocations==before&&call_site[0]==opcode&&call_site[1]==operand);
    }
    assert(!callee->compiled&&callee->compilationFailed);
    size_t before=allocations;
    M3Result error=CompileFunction(callee);
    assert(error&&strcmp(error,"previous WASM function compilation failed")==0);
    assert(allocations==before);
    m3_FreeRuntime(rt);m3_FreeEnvironment(env);
    assert(live==0);
}
int main(void){
    run_case(0,0);run_case(1,0);run_case(0,1);
    puts("lazy compilation: direct/tail failure publication, repeat allocation stability, code-page failure, and teardown passed");
}
