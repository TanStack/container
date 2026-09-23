#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
extern void VMProbeInstall(JSContext *ctx);
static char *read_source(const char *path,size_t *size){
    FILE *file=fopen(path,"rb");if(!file)return NULL;
    fseek(file,0,SEEK_END);long length=ftell(file);rewind(file);
    if(length<0||length>2*1024*1024){fclose(file);return NULL;}
    char *source=malloc(length+1);if(!source){fclose(file);return NULL;}
    if(fread(source,1,length,file)!=(size_t)length){free(source);fclose(file);return NULL;}
    fclose(file);source[length]=0;*size=length;return source;
}
int main(int argc,char **argv){
    if(argc!=3)return 2;
    JSRuntime *rt=JS_NewRuntime();JS_SetMemoryLimit(rt,32*1024*1024);JS_SetMaxStackSize(rt,512*1024);
    JSContext *ctx=JS_NewContext(rt);VMProbeInstall(ctx);
    int failed=0;JSValue result=JS_UNDEFINED;
    for(int i=1;i<3;i++){
        size_t length;char *source=read_source(argv[i],&length);if(!source)return 2;
        JS_FreeValue(ctx,result);result=JS_Eval(ctx,source,length,argv[i],JS_EVAL_TYPE_GLOBAL);free(source);
        if(JS_IsException(result)){failed=1;result=JS_GetException(ctx);break;}
    }
    if(!failed){
        JSContext *job;int count=0,status;
        while((status=JS_ExecutePendingJob(rt,&job))>0){JS_RunGC(rt);if(++count>1000){failed=1;break;}}
        if(status<0){JS_FreeValue(ctx,result);result=JS_GetException(ctx);failed=1;}
        else if(JS_IsObject(result)){
            int state=JS_PromiseState(ctx,result);JSValue value=JS_PromiseResult(ctx,result);JS_FreeValue(ctx,result);result=value;
            if(state!=JS_PROMISE_FULFILLED)failed=1;
        }
    }
    const char *text=JS_ToCString(ctx,result);if(text){fprintf(failed?stderr:stdout,"%s\n",text);JS_FreeCString(ctx,text);}
    JS_FreeValue(ctx,result);JS_FreeContext(ctx);JS_RunGC(rt);JS_FreeRuntime(rt);return failed;
}
