/* Opt-in native spike, appended to QuickJS only by the probe runner. */
typedef struct VMProbeHandle {
    JSContext *ctx;
    JSValue module, edges, callback, self;
    char name[48];
    struct VMProbeHandle *next;
} VMProbeHandle;
static JSClassID vm_probe_class;
static VMProbeHandle *vm_probe_handles;
static unsigned vm_probe_serial, vm_probe_count;
static void vm_probe_release(JSRuntime *rt, VMProbeHandle *h) {
    VMProbeHandle **p=&vm_probe_handles;
    while (*p && *p!=h) p=&(*p)->next;
    if (*p) *p=h->next;
    vm_probe_count--;
    JS_FreeValueRT(rt,h->module);JS_FreeValueRT(rt,h->edges);
    JS_FreeValueRT(rt,h->callback);
    JS_FreeContext(h->ctx);js_free_rt(rt,h);
}
static void vm_probe_finalizer(JSRuntime *rt, JSValue value) {
    VMProbeHandle *h=JS_GetOpaque(value,vm_probe_class);
    if(h)vm_probe_release(rt,h);
}
static void vm_probe_mark(JSRuntime *rt, JSValueConst value, JS_MarkFunc *mark) {
    VMProbeHandle *h=JS_GetOpaque(value,vm_probe_class);
    if(!h)return;
    mark(rt,&h->ctx->header);
    JS_MarkValue(rt,h->module,mark);JS_MarkValue(rt,h->edges,mark);
    JS_MarkValue(rt,h->callback,mark);
}
static VMProbeHandle *vm_probe_get(JSContext *ctx, JSValueConst value) {
    VMProbeHandle *h=JS_GetOpaque2(ctx,value,vm_probe_class);
    if(h&&h->ctx!=ctx){JS_ThrowTypeError(ctx,"Module belongs to another context");return NULL;}
    return h;
}
static JSModuleDef *vm_probe_resolve(JSContext *ctx,const char *base,const char *name,int *handled) {
    VMProbeHandle *h;
    *handled=0;
    for(h=vm_probe_handles;h;h=h->next)if(h->ctx==ctx&&!strcmp(base,h->name)){
        *handled=1;
        JSValue edge=JS_GetPropertyStr(ctx,h->edges,name);
        VMProbeHandle *target=vm_probe_get(ctx,edge);
        JS_FreeValue(ctx,edge);
        if(!target)return NULL;
        return JS_VALUE_GET_PTR(target->module);
    }
    return NULL;
}
static int vm_probe_synthetic_init(JSContext *ctx,JSModuleDef *module) {
    VMProbeHandle *h;
    for(h=vm_probe_handles;h;h=h->next)if(h->ctx==ctx&&JS_VALUE_GET_PTR(h->module)==module){
        JSValue result=JS_Call(ctx,h->callback,h->self,0,NULL);
        if(JS_IsException(result))return -1;
        JS_FreeValue(ctx,result);return 0;
    }
    JS_ThrowReferenceError(ctx,"Synthetic module disposed");return -1;
}
static JSValue vm_probe_create(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv) {
    (void)self;
    if(argc!=2||vm_probe_count>=32||vm_probe_serial>=4096)return JS_ThrowRangeError(ctx,"VM module handle limit");
    VMProbeHandle *h=js_mallocz(ctx,sizeof(*h));if(!h)return JS_EXCEPTION;
    h->ctx=JS_DupContext(ctx);h->module=h->callback=JS_UNDEFINED;
    h->edges=JS_NewObjectProto(ctx,JS_NULL);
    snprintf(h->name,sizeof(h->name),"vm-probe:%u",++vm_probe_serial);
    JSValue object=JS_NewObjectClass(ctx,vm_probe_class);
    if(JS_IsException(object)){JS_FreeValue(ctx,h->edges);JS_FreeContext(h->ctx);js_free(ctx,h);return object;}
    h->self=object; /* Borrowed only while this handle is rooted by the caller/graph. */
    JS_SetOpaque(object,h);h->next=vm_probe_handles;vm_probe_handles=h;vm_probe_count++;
    if(JS_IsString(argv[0])){
        size_t length;const char *source=JS_ToCStringLen(ctx,&length,argv[0]);
        if(!source){JS_FreeValue(ctx,object);return JS_EXCEPTION;}
        if(length>1024*1024){JS_FreeCString(ctx,source);JS_FreeValue(ctx,object);return JS_ThrowRangeError(ctx,"VM module source limit");}
        h->module=JS_Eval(ctx,source,length,h->name,JS_EVAL_TYPE_MODULE|JS_EVAL_FLAG_COMPILE_ONLY|(1<<8));
        JS_FreeCString(ctx,source);
        if(JS_IsException(h->module)){h->module=JS_UNDEFINED;JS_FreeValue(ctx,object);return JS_EXCEPTION;}
    }else{
        uint32_t length;JSValue size=JS_GetPropertyStr(ctx,argv[0],"length");
        int failed=JS_ToUint32(ctx,&length,size);JS_FreeValue(ctx,size);
        if(failed<0||length>128){JS_FreeValue(ctx,object);return JS_ThrowRangeError(ctx,"Synthetic export limit");}
        JSModuleDef *m=JS_NewCModule(ctx,h->name,vm_probe_synthetic_init);
        if(!m){JS_FreeValue(ctx,object);return JS_EXCEPTION;}
        h->module=JS_DupValue(ctx,JS_MKPTR(JS_TAG_MODULE,m));h->callback=JS_DupValue(ctx,argv[1]);
        for(uint32_t i=0;i<length;i++){
            JSValue item=JS_GetPropertyUint32(ctx,argv[0],i);const char *name=JS_ToCString(ctx,item);JS_FreeValue(ctx,item);
            if(!name){JS_FreeValue(ctx,object);return JS_EXCEPTION;}
            int status=JS_AddModuleExport(ctx,m,name);JS_FreeCString(ctx,name);
            if(status<0){JS_FreeValue(ctx,object);return JS_EXCEPTION;}
        }
    }
    return object;
}
static JSValue vm_probe_operation(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv,int op) {
    (void)self;if(argc<1)return JS_ThrowTypeError(ctx,"Missing module handle");
    VMProbeHandle *h=vm_probe_get(ctx,argv[0]);if(!h)return JS_EXCEPTION;
    JSModuleDef *m=JS_VALUE_GET_PTR(h->module);
    if(op==0){
        JSValue array=JS_NewArray(ctx);
        for(int i=0;i<m->req_module_entries_count;i++)JS_SetPropertyUint32(ctx,array,i,JS_AtomToString(ctx,m->req_module_entries[i].module_name));
        return array;
    }
    if(op==1){
        if(argc!=3||!vm_probe_get(ctx,argv[2]))return JS_EXCEPTION;
        const char *name=JS_ToCString(ctx,argv[1]);if(!name)return JS_EXCEPTION;
        int result=JS_SetPropertyStr(ctx,h->edges,name,JS_DupValue(ctx,argv[2]));JS_FreeCString(ctx,name);
        return result<0?JS_EXCEPTION:JS_UNDEFINED;
    }
    if(op==2){
        if(JS_ResolveModule(ctx,h->module)<0||js_create_module_function(ctx,m)<0||js_link_module(ctx,m)<0)return JS_EXCEPTION;
        return JS_UNDEFINED;
    }
    if(op==3)return JS_EvalFunction(ctx,JS_DupValue(ctx,h->module));
    if(op==4)return JS_GetModuleNamespace(ctx,m);
    if(op==5){
        if(argc!=3)return JS_ThrowTypeError(ctx,"Missing export value");
        if(m->status<JS_MODULE_STATUS_LINKED)return JS_ThrowTypeError(ctx,"Synthetic module is not linked");
        const char *name=JS_ToCString(ctx,argv[1]);if(!name)return JS_EXCEPTION;
        int result=JS_SetModuleExport(ctx,m,name,JS_DupValue(ctx,argv[2]));JS_FreeCString(ctx,name);
        return result<0?JS_ThrowReferenceError(ctx,"Unknown module export"):JS_UNDEFINED;
    }
    if(op==6)return JS_GetImportMeta(ctx,m);
    if(op==7){JS_SetOpaque(argv[0],NULL);vm_probe_release(ctx->rt,h);return JS_UNDEFINED;}
    if(op==8){
        const char *states[]={"unlinked","linking","linked","evaluating","evaluating","evaluated"};
        return JS_NewString(ctx,m->eval_has_exception?"errored":states[m->status]);
    }
    if(op==9)return JS_DupValue(ctx,m->eval_exception);
    if(op==10){
        if(argc!=2||!JS_IsFunction(ctx,argv[1])||JS_VALUE_GET_TAG(m->func_obj)!=JS_TAG_FUNCTION_BYTECODE)return JS_ThrowTypeError(ctx,"Invalid module import callback");
        if(vm_attach_import(ctx,JS_VALUE_GET_PTR(m->func_obj),argv[1])<0)return JS_EXCEPTION;
        return JS_UNDEFINED;
    }
    return JS_ThrowTypeError(ctx,"Invalid VM operation");
}
void VMProbeInstall(JSContext *ctx) {
    if(!vm_probe_class)JS_NewClassID(&vm_probe_class);
    JSClassDef definition={"VMModuleHandle",.finalizer=vm_probe_finalizer,.gc_mark=vm_probe_mark};
    JS_NewClass(ctx->rt,vm_probe_class,&definition);
    JSValue api=JS_NewObject(ctx);
    JS_SetPropertyStr(ctx,api,"create",JS_NewCFunction(ctx,vm_probe_create,"create",2));
    const char *names[]={"requests","edge","link","evaluate","namespace","setExport","meta","dispose","status","error","importCallback"};
    for(int i=0;i<11;i++)JS_SetPropertyStr(ctx,api,names[i],JS_NewCFunctionMagic(ctx,vm_probe_operation,names[i],3,JS_CFUNC_generic_magic,i));
    JS_SetPropertyStr(ctx,ctx->global_obj,"vmNative",api);
}
