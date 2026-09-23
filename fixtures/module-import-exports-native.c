#include "quickjs.h"
#include <stdio.h>
#include <string.h>
static JSModuleDef *load(JSContext *ctx,const char *name,void *opaque){
  (void)opaque;
  const char *source =
    !strcmp(name,"/server") ? "import {load as original,change} from '/load';export {original as load,change}" :
    !strcmp(name,"/load") ? "import {Router} from '/router';export function load(){return 42};export function change(){load=()=>43}" :
    !strcmp(name,"/router") ? "import {load} from '/server';export class Router{constructor(){this.load=async()=>load()}}" :
    !strcmp(name,"/namespace") ? "import * as ns from '/server';export {ns}" :
    !strcmp(name,"/diamond") ? "export * from '/server';export * from '/load'" :
    !strcmp(name,"/other") ? "export const load=99" :
    !strcmp(name,"/ambiguous") ? "export * from '/server';export * from '/other'" :
    !strcmp(name,"/bad") ? "import {load} from '/ambiguous';export {load}" :
    !strcmp(name,"/missing") ? "import {absent} from '/server';export {absent}" :
    !strcmp(name,"/circular-a") ? "import {x} from '/circular-b';export {x}" :
    !strcmp(name,"/circular-b") ? "import {x} from '/circular-a';export {x}" :
    !strcmp(name,"/tdz-a") ? "import '/tdz-b';export let value=1" :
    !strcmp(name,"/tdz-b") ? "import {value} from '/tdz-a';globalThis.read=value" : NULL;
  if(!source){JS_ThrowReferenceError(ctx,"missing fixture");return NULL;}
  JSValue value=JS_Eval(ctx,source,strlen(source),name,JS_EVAL_TYPE_MODULE|JS_EVAL_FLAG_COMPILE_ONLY);
  if(JS_IsException(value))return NULL;
  JSModuleDef *module=JS_VALUE_GET_PTR(value);JS_FreeValue(ctx,value);return module;
}
int main(void){
  JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);
  JS_SetMemoryLimit(rt,32*1024*1024);JS_SetMaxStackSize(rt,256*1024);
  JS_SetModuleLoaderFunc(rt,NULL,load,NULL);
  const char *source=
    "import * as server from '/server';import {Router} from '/router';"
    "import {ns} from '/namespace';import {load as diamond} from '/diamond';"
    "const check=v=>{if(!v)throw Error('check failed')};"
    "globalThis.done=false;globalThis.failure=null;"
    "(async()=>{check(typeof server.load==='function');check(ns===server);"
    "const router=new Router();check(await router.load()===42);check(diamond()===42);"
    "server.change();check(await router.load()===43);check(ns.load()===43);check(diamond()===43);"
    "for(const name of ['/bad','/missing','/circular-a']){let rejected=false;try{await import(name)}catch(e){rejected=e instanceof SyntaxError}check(rejected)}"
    "let tdz=false;try{await import('/tdz-a')}catch(e){tdz=e instanceof ReferenceError}check(tdz);done=true"
    "})().catch(e=>failure=e);";
  JSValue value=JS_Eval(ctx,source,strlen(source),"/entry",JS_EVAL_TYPE_MODULE);
  int status=JS_IsException(value);JS_FreeValue(ctx,value);
  if(!status){int jobs;JSContext *job;while((jobs=JS_ExecutePendingJob(rt,&job))>0){}if(jobs<0)status=1;}
  if(!status){const char *finish="if(failure)throw failure;if(!done)throw Error('unfinished')";value=JS_Eval(ctx,finish,strlen(finish),"finish.js",0);status=JS_IsException(value);JS_FreeValue(ctx,value);}
  if(status){JSValue error=JS_GetException(ctx);const char *text=JS_ToCString(ctx,error);fprintf(stderr,"%s\n",text);JS_FreeCString(ctx,text);JS_FreeValue(ctx,error);}
  JS_FreeContext(ctx);JS_FreeRuntime(rt);return status;
}
