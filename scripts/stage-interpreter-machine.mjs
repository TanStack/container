import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'

const marker='/* argv[] is modified if (flags & JS_CALL_FLAG_COPY_ARGV) = 0. */\nstatic JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj,'
const families=[
  ['Stack','        CASE(OP_push_i32):','#if SHORT_OPCODES\n        CASE(OP_call0):','37325179e7d2c999e058ceb1eecfad8c50391a1afc70934cc5434548f4e6e62e',`push_i32 push_bigint_i32 push_const push_minus1 push_0 push_1 push_2 push_3 push_4 push_5 push_6 push_7 push_i8 push_i16 push_const8 fclosure8 push_empty_string push_atom_value undefined null push_this push_false push_true object special_object rest drop nip nip1 dup dup2 dup3 dup1 insert2 insert3 insert4 perm3 rot3l rot4l rot5l rot3r perm4 perm5 swap swap2 fclosure`],
  ['Locals','        CASE(OP_get_var_undef):','        CASE(OP_for_in_start):','780c0ba10b08aa8b5ef35479df2bf8d4cf33f0d7e09ecb869ed232967ff23902',`get_var_undef get_var put_var put_var_init get_loc put_loc set_loc get_arg put_arg set_arg get_loc8 put_loc8 set_loc8 get_loc0 get_loc1 get_loc2 get_loc3 put_loc0 put_loc1 put_loc2 put_loc3 set_loc0 set_loc1 set_loc2 set_loc3 get_arg0 get_arg1 get_arg2 get_arg3 put_arg0 put_arg1 put_arg2 put_arg3 set_arg0 set_arg1 set_arg2 set_arg3 get_var_ref0 get_var_ref1 get_var_ref2 get_var_ref3 put_var_ref0 put_var_ref1 put_var_ref2 put_var_ref3 set_var_ref0 set_var_ref1 set_var_ref2 set_var_ref3 get_var_ref put_var_ref set_var_ref get_var_ref_check put_var_ref_check put_var_ref_check_init set_loc_uninitialized get_loc_check get_loc_checkthis put_loc_check set_loc_check put_loc_check_init close_loc make_loc_ref make_arg_ref make_var_ref_ref make_var_ref goto goto16 goto8 if_true if_false if_true8 if_false8 catch gosub ret`],
  ['Iterator','        CASE(OP_for_in_start):','        CASE(OP_lnot):','225ad0789d1331f2647b19133a0a4d056765ec92d5a31d4d1275ff409c0a4274',`for_in_start for_in_next for_of_start for_of_next for_await_of_next for_await_of_start iterator_get_value_done iterator_check_object iterator_close nip_catch iterator_next iterator_call`],
  ['Property','#define GET_FIELD_INLINE(name, keep, is_length)','        CASE(OP_add):','b6c216684c5bad0d538daa58863f52f2c8820aec003bed512c0489d60cba1bac',`get_field get_field2 get_length put_field private_symbol get_private_field put_private_field define_private_field define_field set_name set_name_computed set_proto set_home_object define_method define_method_computed define_class define_class_computed get_array_el get_array_el2 get_array_el3 get_ref_value get_super_value put_array_el put_ref_value put_super_value define_array_el append copy_data_properties`],
  ['Numeric','        CASE(OP_add):','        CASE(OP_in):','af2bc1e584731538afe8b9ed3e616fca22c850ebffea97d108bf268b37d8efc9',`add add_loc sub mul div mod pow plus neg inc dec post_inc post_dec inc_loc dec_loc not shl shr sar and or xor lt lte gt gte eq neq strict_eq strict_neq`],
  ['Scope','        CASE(OP_in):','        CASE(OP_await):','dd01b5427a067c64b5d4d8ef87fe56133e5e91c1548a51dfcf92c522cc0b9967',`in private_in instanceof typeof delete delete_var to_object to_propkey with_get_var with_put_var with_delete_var with_make_ref with_get_ref`],
  ['Terminal','        CASE(OP_await):','        CASE(OP_invalid):','1526bf8ca6844f57976203859720122afc515d26a756399188a43021e2b7accb',`await yield yield_star async_yield_star return_async initial_yield nop is_undefined_or_null is_undefined is_null typeof_is_undefined typeof_is_function`],
].map(([name,start,end,sha,opcodes])=>({name,start,end,sha,opcodes:opcodes.split(' ')}))

const hash=value=>createHash('sha256').update(value).digest('hex')

export function stageInterpreterMachine(file){
  let source=readFileSync(file,'utf8')
  if(source.includes('typedef struct QJSDispatchState'))throw Error('Unexpected interpreter machine integration site: already staged')
  if(source.split(marker).length!==2)throw Error('Unexpected interpreter machine marker')
  const helpers=[]
  for(const family of families){
    const start=source.indexOf(family.start),end=source.indexOf(family.end,start)
    if(start<0||end<0||end<=start)throw Error('Unexpected '+family.name+' family bounds')
    const body=source.slice(start,end)
    if(hash(body)!==family.sha)throw Error('Unexpected '+family.name+' family source')
    const macroOpcodes=family.name==='Numeric'?['lt','lte','gt','gte','eq','neq','strict_eq','strict_neq']:[]
    const literal=[...body.matchAll(/CASE\(OP_([\w]+)\):/g)].map(match=>match[1]).filter(opcode=>opcode!=='to_string')
    if([...literal,...macroOpcodes].sort().join(',')!==[...family.opcodes].sort().join(','))throw Error('Unexpected '+family.name+' opcode inventory')
    const prefix='QJS_'+family.name.toUpperCase()
    const staged=body.replaceAll('CASE(',prefix+'_CASE(').replaceAll('BREAK',prefix+'_BREAK').replaceAll('goto exception;','goto qjs_handler_exception;').replaceAll('goto done_generator;','goto qjs_handler_yield;')
    helpers.push(`static __attribute__((noinline)) int JS_Execute${family.name}Opcodes(QJSDispatchState *state) {
  JSContext *caller_ctx=state->caller_ctx,*ctx=state->ctx; JSRuntime *rt=state->rt;
  JSObject *p=state->p; JSFunctionBytecode *b=state->b; JSStackFrame *sf=state->sf;
  const uint8_t *pc=state->pc; int opcode=state->opcode,argc=state->argc,flags=state->flags,arg_allocated_size=state->arg_allocated_size,i;
  JSValue func_obj=state->func_obj,this_obj=state->this_obj,new_target=state->new_target,ret_val,*pval;
  JSValue *argv=state->argv,*local_buf=state->local_buf,*stack_buf=state->stack_buf,*var_buf=state->var_buf,*arg_buf=state->arg_buf,*sp=state->sp; JSVarRef **var_refs=state->var_refs;
#define ${prefix}_CASE(op) case op
#define ${prefix}_BREAK goto qjs_handler_continue
  switch(opcode) {
${staged}
  default: abort(); }
qjs_handler_continue:
  state->pc=pc;state->sp=sp;state->opcode=opcode;return QJS_ACTION_CONTINUE;
qjs_handler_exception:
  state->pc=pc;state->sp=sp;state->opcode=opcode;return QJS_ACTION_EXCEPTION;
qjs_handler_yield:
  state->pc=pc;state->sp=sp;state->opcode=opcode;state->result=ret_val;return QJS_ACTION_YIELD;
#undef ${prefix}_CASE
#undef ${prefix}_BREAK
}
`)
    const routes=family.opcodes.map(op=>`        CASE(OP_${op}):`).join('\n')
    const dispatch=`${routes}
            { QJSDispatchState state={caller_ctx,ctx,rt,p,b,sf,pc,opcode,argc,flags,arg_allocated_size,func_obj,this_obj,new_target,argv,local_buf,stack_buf,var_buf,arg_buf,sp,var_refs,JS_UNDEFINED};
              int action=JS_Execute${family.name}Opcodes(&state); pc=state.pc;sp=state.sp;opcode=state.opcode;
              if(unlikely(action==QJS_ACTION_EXCEPTION))goto exception; if(unlikely(action==QJS_ACTION_YIELD)){ret_val=state.result;goto done_generator;} }
            BREAK;

`
    source=source.slice(0,start)+dispatch+source.slice(end)
  }
  const callStart='#if SHORT_OPCODES\n        CASE(OP_call0):'
  const constructor='        CASE(OP_call_constructor):'
  const methodStart='        CASE(OP_call_method):'
  const arrayFrom='        CASE(OP_array_from):'
  const firstStart=source.indexOf(callStart),firstEnd=source.indexOf(constructor,firstStart)
  const secondStart=source.indexOf(methodStart,firstEnd),secondEnd=source.indexOf(arrayFrom,secondStart)
  if(firstStart<0||firstEnd<0||secondStart<0||secondEnd<0)throw Error('Unexpected typed call transition bounds')
  const firstCallBody=source.slice(firstStart,firstEnd),secondCallBody=source.slice(secondStart,secondEnd)
  if(hash(firstCallBody)!=='63550112ae7346f82913c8cdffe2caa670f37b30124871f4e077dc2fb4e10893')throw Error('Unexpected direct call transition source')
  if(hash(secondCallBody)!=='206ffefc44f41498a19528a073767d98227efc6e44070e46cae0d7f910b246ab')throw Error('Unexpected method call transition source')
  const callRoutes=`#if SHORT_OPCODES
        CASE(OP_call0):
        CASE(OP_call1):
        CASE(OP_call2):
        CASE(OP_call3):
#endif
        CASE(OP_call):
        CASE(OP_tail_call):
        CASE(OP_call_method):
        CASE(OP_tail_call_method):
            { QJSDispatchState state={caller_ctx,ctx,rt,p,b,sf,pc,opcode,argc,flags,arg_allocated_size,func_obj,this_obj,new_target,argv,local_buf,stack_buf,var_buf,arg_buf,sp,var_refs,JS_UNDEFINED};
              int action=JS_ExecuteCallOpcodes(&state); pc=state.pc;sp=state.sp;
              if(unlikely(action==QJS_ACTION_EXCEPTION))goto exception;
              if(unlikely(action==QJS_ACTION_RETURN)){ret_val=state.result;goto done;}
              if(unlikely(action==QJS_ACTION_ENTER_BYTECODE)){
                JSFunctionBytecode *child=JS_VALUE_GET_OBJ(state.call_func)->u.func.function_bytecode;
                size_t bytes=sizeof(JSValue)*((state.call_argc<child->arg_count?child->arg_count:0)+child->var_count+child->stack_size)+sizeof(JSVarRef*)*child->var_ref_count;
                QJSInterpreterFrame *next;
                if(js_poll_interrupts(ctx))goto exception;
                if(rt->interpreter_frame_depth>=4096){JS_ThrowStackOverflow(ctx);goto exception;}
                next=js_malloc(ctx,sizeof(*next)+bytes);if(!next)goto exception;
                next->caller_ctx=caller_ctx;next->ctx=ctx;next->p=p;next->b=b;next->sf=sf;next->pc=pc;next->opcode=opcode;next->argc=argc;next->flags=flags;next->arg_allocated_size=arg_allocated_size;
                next->func_obj=func_obj;next->this_obj=this_obj;next->new_target=new_target;next->argv=argv;next->local_buf=local_buf;next->stack_buf=stack_buf;next->var_buf=var_buf;next->arg_buf=arg_buf;next->sp=sp;next->var_refs=var_refs;
                next->previous=parents;next->child_argc=state.call_argc;next->argument_prefix=state.call_prefix;next->tail_call=state.call_tail;parents=next;rt->interpreter_frame_depth++;
                caller_ctx=ctx;func_obj=state.call_func;this_obj=state.call_this;new_target=JS_UNDEFINED;argc=state.call_argc;argv=state.call_argv;flags=0;sf=&next->child_frame;p=JS_VALUE_GET_OBJ(func_obj);goto enter_bytecode;
              }}
            BREAK;
`
  source=source.slice(0,firstStart)+callRoutes+source.slice(firstEnd,secondStart)+source.slice(secondEnd)
  helpers.push(`static __attribute__((noinline)) int JS_ExecuteCallOpcodes(QJSDispatchState *state) {
  JSContext *ctx=state->ctx; const uint8_t *pc=state->pc; JSValue *sp=state->sp,*call_argv,ret_val; int opcode=state->opcode,call_argc,i,method=0;
  switch(opcode){
#if SHORT_OPCODES
  case OP_call0:case OP_call1:case OP_call2:case OP_call3:call_argc=opcode-OP_call0;break;
#endif
  case OP_call:case OP_tail_call:call_argc=get_u16(pc);pc+=2;break;
  case OP_call_method:case OP_tail_call_method:method=1;call_argc=get_u16(pc);pc+=2;break;
  default:abort();}
  call_argv=sp-call_argc;state->sf->cur_pc=pc;state->pc=pc;
  state->call_argc=call_argc;state->call_argv=call_argv;state->call_func=call_argv[-1];state->call_this=method?call_argv[-2]:JS_UNDEFINED;state->call_prefix=method?2:1;state->call_tail=opcode==(method?OP_tail_call_method:OP_tail_call);
  if(JS_VALUE_GET_TAG(state->call_func)==JS_TAG_OBJECT&&JS_VALUE_GET_OBJ(state->call_func)->class_id==JS_CLASS_BYTECODE_FUNCTION)return QJS_ACTION_ENTER_BYTECODE;
  ret_val=JS_CallInternal(ctx,state->call_func,state->call_this,JS_UNDEFINED,call_argc,call_argv,0);
  if(unlikely(JS_IsException(ret_val))){state->sp=sp;return QJS_ACTION_EXCEPTION;}
  if(state->call_tail){state->result=ret_val;state->sp=sp;return QJS_ACTION_RETURN;}
  for(i=-state->call_prefix;i<call_argc;i++)JS_FreeValue(ctx,call_argv[i]);sp-=call_argc+state->call_prefix;*sp++=ret_val;state->sp=sp;return QJS_ACTION_CONTINUE;
}
`)
  const support=`typedef struct QJSDispatchState {
  JSContext *caller_ctx,*ctx; JSRuntime *rt; JSObject *p; JSFunctionBytecode *b; JSStackFrame *sf; const uint8_t *pc;
  int opcode,argc,flags,arg_allocated_size; JSValue func_obj,this_obj,new_target,*argv,*local_buf,*stack_buf,*var_buf,*arg_buf,*sp; JSVarRef **var_refs; JSValue result;
  int call_argc,call_prefix,call_tail; JSValue *call_argv; JSValue call_func,call_this;
} QJSDispatchState;
enum { QJS_ACTION_CONTINUE,QJS_ACTION_EXCEPTION,QJS_ACTION_ENTER_BYTECODE,QJS_ACTION_RETURN,QJS_ACTION_YIELD };
static JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj, JSValueConst this_obj, JSValueConst new_target, int argc, JSValue *argv, int flags);
${helpers.join('\n')}
`
  source=source.replace(marker,support+marker)
  writeFileSync(file,source)
}

export const interpreterMachineFamilies=families.map(({name,opcodes})=>({name,opcodes:[...opcodes]}))
