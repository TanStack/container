import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stageInterpreterMachine,interpreterMachineFamilies} from './stage-interpreter-machine.mjs'

const liveFields={
  Stack:['ctx','p','b','sf','pc','opcode','argc','this_obj','new_target','argv','sp','var_refs'],
  Locals:['caller_ctx','ctx','rt','b','sf','pc','opcode','var_buf','arg_buf','sp','var_refs'],
  Iterator:['ctx','sf','pc','opcode','flags','stack_buf','sp'],
  Property:['ctx','p','sf','pc','opcode','flags','sp','var_refs'],
  Numeric:['ctx','sf','pc','opcode','var_buf','sp'],
  Scope:['ctx','sf','pc','opcode','sp'],
  Terminal:['ctx','pc','opcode','sp'],
}

const fieldTypes={
  caller_ctx:'JSContext *',ctx:'JSContext *',rt:'JSRuntime *',p:'JSObject *',b:'JSFunctionBytecode *',sf:'JSStackFrame *',pc:'const uint8_t *',
  opcode:'int ',argc:'int ',flags:'int ',this_obj:'JSValue ',new_target:'JSValue ',argv:'JSValue *',stack_buf:'JSValue *',var_buf:'JSValue *',arg_buf:'JSValue *',sp:'JSValue *',var_refs:'JSVarRef **',
}
const dispatchFieldNames=Object.keys(fieldTypes)

function replaceOnce(source,from,to,label){
  if(source.split(from).length!==2)throw Error('Unexpected batched interpreter integration site: '+label)
  return source.replace(from,to)
}

function classifier(){
  const values=interpreterMachineFamilies.map(({name})=>`QJS_FAMILY_${name.toUpperCase()}`).join(',')
  const routes=interpreterMachineFamilies.map(({name,opcodes})=>`${opcodes.map(opcode=>`  case OP_${opcode}:`).join('\n')} return QJS_FAMILY_${name.toUpperCase()};`).join('\n')
  return `enum { ${values} };
static int QJS_OpcodeFamily(int opcode) {
  switch(opcode) {
${routes}
  default: return -1;
  }
}
`
}

function refresh(){
  // opcode is intentionally absent. The original interpreter initializes it
  // in SWITCH(pc), after restart, including on the first bytecode entry.
  const fields=[...new Set(Object.values(liveFields).flat())].filter(name=>name!=='opcode')
  return `    dispatch_state=(QJSDispatchState){0};
${fields.map(name=>`    dispatch_state.${name}=${name};`).join('\n')}`
}

export function stageBatchedInterpreterMachine(file){
  const directory=mkdtempSync(join(tmpdir(),'qjs-batched-machine-stage-'))
  const stagedFile=join(directory,'quickjs.c')
  try{
    writeFileSync(stagedFile,readFileSync(file))
    stageInterpreterMachine(stagedFile)
    let source=readFileSync(stagedFile,'utf8')

    source=replaceOnce(source,
      'enum { QJS_ACTION_CONTINUE,QJS_ACTION_EXCEPTION,QJS_ACTION_ENTER_BYTECODE,QJS_ACTION_RETURN,QJS_ACTION_YIELD };\n',
      'enum { QJS_ACTION_CONTINUE,QJS_ACTION_EXCEPTION,QJS_ACTION_ENTER_BYTECODE,QJS_ACTION_RETURN,QJS_ACTION_YIELD };\n'+classifier(),
      'opcode family classifier')

    for(const {name} of interpreterMachineFamilies){
      const prefix='QJS_'+name.toUpperCase()
      const oldPrologue=`static __attribute__((noinline)) int JS_Execute${name}Opcodes(QJSDispatchState *state) {
  JSContext *caller_ctx=state->caller_ctx,*ctx=state->ctx; JSRuntime *rt=state->rt;
  JSObject *p=state->p; JSFunctionBytecode *b=state->b; JSStackFrame *sf=state->sf;
  const uint8_t *pc=state->pc; int opcode=state->opcode,argc=state->argc,flags=state->flags,arg_allocated_size=state->arg_allocated_size,i;
  JSValue func_obj=state->func_obj,this_obj=state->this_obj,new_target=state->new_target,ret_val,*pval;
  JSValue *argv=state->argv,*local_buf=state->local_buf,*stack_buf=state->stack_buf,*var_buf=state->var_buf,*arg_buf=state->arg_buf,*sp=state->sp; JSVarRef **var_refs=state->var_refs;
#define ${prefix}_CASE(op) case op
#define ${prefix}_BREAK goto qjs_handler_continue
  switch(opcode) {`
      const oldHelperStart=source.indexOf(oldPrologue)
      const oldHelperEnd=source.indexOf('\n  default: abort(); }',oldHelperStart+oldPrologue.length)
      if(oldHelperStart<0||oldHelperEnd<0)throw Error('Unexpected batched interpreter integration site: '+name+' live field bounds')
      const oldBody=source.slice(oldHelperStart+oldPrologue.length,oldHelperEnd)
      for(const field of dispatchFieldNames){
        const used=new RegExp(`\\b${field}\\b`).test(oldBody)||['pc','opcode','sp'].includes(field)
        if(used!==liveFields[name].includes(field))throw Error('Unexpected '+name+' live dispatch field: '+field)
      }
      const declarations=liveFields[name].map(field=>`  ${fieldTypes[field]}${field}=state->${field};`).join('\n')
      const newPrologue=`static __attribute__((noinline)) int JS_Execute${name}Opcodes(QJSDispatchState *state) {
${declarations}
  int i; JSValue ret_val,*pval;
#define ${prefix}_CASE(op) case op
#define ${prefix}_BREAK goto qjs_handler_next
qjs_handler_dispatch:
  switch(opcode) {`
      source=replaceOnce(source,oldPrologue,newPrologue,name+' helper prologue')
      const helperStart=source.indexOf(newPrologue)
      const nextHelper=source.indexOf('\nstatic __attribute__((noinline)) int JS_Execute',helperStart+newPrologue.length)
      const marker=source.indexOf('\n/* argv[] is modified',helperStart+newPrologue.length)
      const helperEnd=nextHelper<0?marker:Math.min(nextHelper,marker)
      if(helperStart<0||helperEnd<0)throw Error('Unexpected batched interpreter integration site: '+name+' helper bounds')
      const helper=replaceOnce(source.slice(helperStart,helperEnd),
        `qjs_handler_continue:\n  state->pc=pc;state->sp=sp;state->opcode=opcode;return QJS_ACTION_CONTINUE;\nqjs_handler_exception:`,
        `qjs_handler_next:\n  if(QJS_OpcodeFamily(*pc)==QJS_FAMILY_${name.toUpperCase()}){opcode=*pc++;goto qjs_handler_dispatch;}\nqjs_handler_continue:\n  state->pc=pc;state->sp=sp;state->opcode=opcode;return QJS_ACTION_CONTINUE;\nqjs_handler_exception:`,
        name+' same-family continuation')
      source=source.slice(0,helperStart)+helper+source.slice(helperEnd)
    }

    const aggregate='QJSDispatchState state={caller_ctx,ctx,rt,p,b,sf,pc,opcode,argc,flags,arg_allocated_size,func_obj,this_obj,new_target,argv,local_buf,stack_buf,var_buf,arg_buf,sp,var_refs,JS_UNDEFINED};'
    const coordinatorMarker='/* argv[] is modified if (flags & JS_CALL_FLAG_COPY_ARGV) = 0. */\nstatic JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj,'
    const coordinatorStart=source.indexOf(coordinatorMarker)
    const coordinatorEnd=source.indexOf('\nJSValue JS_Call(',coordinatorStart)
    if(coordinatorStart<0||coordinatorEnd<0)throw Error('Unexpected batched interpreter integration site: coordinator bounds')
    let coordinator=source.slice(coordinatorStart,coordinatorEnd)
    const aggregateCount=coordinator.split(aggregate).length-1
    if(aggregateCount!==interpreterMachineFamilies.length+1)throw Error('Unexpected batched interpreter integration site: dispatch aggregates')
    if(coordinator.split('(&state)').length-1!==interpreterMachineFamilies.length+1)throw Error('Unexpected batched interpreter integration site: dispatch calls')
    coordinator=coordinator.replaceAll(aggregate,'dispatch_state.pc=pc;dispatch_state.sp=sp;dispatch_state.opcode=opcode;')
    coordinator=coordinator.replaceAll('(&state)','(&dispatch_state)')
    coordinator=coordinator.replaceAll('pc=state.pc;sp=state.sp;opcode=state.opcode;','pc=dispatch_state.pc;sp=dispatch_state.sp;opcode=dispatch_state.opcode;')
    coordinator=coordinator.replaceAll('pc=state.pc;sp=state.sp;','pc=dispatch_state.pc;sp=dispatch_state.sp;')
    for(const field of ['result','call_func','call_argc','call_this','call_argv','call_prefix','call_tail'])coordinator=coordinator.replaceAll(`state.${field}`,`dispatch_state.${field}`)

    coordinator=replaceOnce(coordinator,
      '    size_t alloca_size;\n    QJSInterpreterFrame *parents = NULL;',
      '    size_t alloca_size;\n    QJSInterpreterFrame *parents = NULL;\n    QJSDispatchState dispatch_state;',
      'persistent dispatch state declaration')
    coordinator=replaceOnce(coordinator,' restart:\n    for(;;) {',' restart:\n'+refresh()+'\n    for(;;) {','bytecode entry state refresh')
    if(/\bstate\./.test(coordinator)||coordinator.includes('(&state)'))throw Error('Unexpected batched interpreter integration site: coordinator state reference remains')
    source=source.slice(0,coordinatorStart)+coordinator+source.slice(coordinatorEnd)
    if(source.includes('QJSDispatchState state={'))throw Error('Unexpected batched interpreter integration site: per-route state remains')
    writeFileSync(file,source)
  }finally{
    rmSync(directory,{recursive:true,force:true})
  }
}

export const batchedInterpreterMachineFamilies=interpreterMachineFamilies
