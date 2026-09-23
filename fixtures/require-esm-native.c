#include "quickjs.h"
#include <stdio.h>
#include <string.h>
static JSModuleDef *load(JSContext *ctx,const char *name,void *opaque){
  (void)opaque;
  const char *source = !strcmp(name,"/plain") ? "export let value=1;export function bump(){value++}" :
    !strcmp(name,"/default") ? "export let value=1;export {value as default};export function bump(){value++}" :
    !strcmp(name,"/explicit") ? "export default 1;export const __esModule=false" :
    !strcmp(name,"/override") ? "export default 1;export const value=2;export {value as 'module.exports'}" :
    !strcmp(name,"/tla") ? "globalThis.tlaRan=true;await 0;export const value=3" :
    !strcmp(name,"/parent") ? "import '/tla';globalThis.parentRan=true" :
    !strcmp(name,"/bad") ? "throw globalThis.failure" :
    !strcmp(name,"/cycle") ? "__qjsRequireESM('/cycle')" : NULL;
  if(!source){JS_ThrowReferenceError(ctx,"missing module");return NULL;}
  JSValue value=JS_Eval(ctx,source,strlen(source),name,JS_EVAL_TYPE_MODULE|JS_EVAL_FLAG_COMPILE_ONLY);
  if(JS_IsException(value))return NULL;
  JSModuleDef *module=JS_VALUE_GET_PTR(value);JS_FreeValue(ctx,value);return module;
}
int main(void){
  JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);
  JS_SetModuleLoaderFunc(rt,NULL,load,NULL);
  const char *source=
    "const check=(value)=>{if(!value)throw Error('check failed')};"
    "globalThis.queued=false;Promise.resolve().then(()=>queued=true);"
    "const ns=__qjsRequireESM('/plain');check(ns===__qjsRequireESM('/plain'));"
    "check(ns.value===1);ns.bump();check(ns.value===2);check(!queued);"
    "globalThis.facade=__qjsRequireESM('/default');check(facade===__qjsRequireESM('/default'));check(facade.__esModule===true);"
    "check(!Object.isExtensible(facade));check(Object.prototype.toString.call(facade)==='[object Module]');"
    "const descriptor=Object.getOwnPropertyDescriptor(facade,'__esModule');check(descriptor.writable&&descriptor.enumerable&&!descriptor.configurable);"
    "facade.bump();check(facade.default===2);check(__qjsRequireESM('/explicit').__esModule===false);check(!('__esModule' in __qjsRequireESM('/override')));"
    "for(const name of ['/tla','/parent']){try{__qjsRequireESM(name);throw Error('accepted TLA')}catch(e){check(e.code==='ERR_REQUIRE_ASYNC_MODULE')}}"
    "check(!globalThis.tlaRan&&!globalThis.parentRan);"
    "globalThis.failure=Error('original');for(let i=0;i<2;i++){try{__qjsRequireESM('/bad');throw Error('accepted error')}catch(e){check(e===failure)}}"
    "try{__qjsRequireESM('/cycle');throw Error('accepted cycle')}catch(e){check(e.code==='ERR_REQUIRE_CYCLE_MODULE')}"
    "globalThis.done=false;globalThis.defaultDone=false;import('/plain').then(other=>{check(other===ns);done=true});"
    "import('/default').then(other=>{check(other!==facade);check(other.default===2);other.bump();check(facade.default===3);defaultDone=true});";
  JSValue value=JS_Eval(ctx,source,strlen(source),"test.js",JS_EVAL_TYPE_GLOBAL);
  int status=0;
  if(JS_IsException(value))status=1;
  JS_FreeValue(ctx,value);
  if(!status){int jobs;JSContext *job_context;while((jobs=JS_ExecutePendingJob(rt,&job_context))>0){}if(jobs<0)status=1;}
  if(!status){const char *finish="if(!done||!defaultDone)throw Error('import did not finish')";value=JS_Eval(ctx,finish,strlen(finish),"finish.js",0);status=JS_IsException(value);JS_FreeValue(ctx,value);}
  if(status){JSValue error=JS_GetException(ctx);const char *text=JS_ToCString(ctx,error);fprintf(stderr,"%s\n",text);JS_FreeCString(ctx,text);JS_FreeValue(ctx,error);}
  JS_FreeContext(ctx);JS_FreeRuntime(rt);return status;
}
