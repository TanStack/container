import {readFileSync,writeFileSync} from 'node:fs'

const helperMarker='/* argv[] is modified if (flags & JS_CALL_FLAG_COPY_ARGV) = 0. */\nstatic JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj,'
const familyStart='#define GET_FIELD_INLINE(name, keep, is_length)'
const familyEnd='        CASE(OP_add):'

const routedOpcodes=[
  'get_field','get_field2','get_length','put_field','private_symbol',
  'get_private_field','put_private_field','define_private_field','define_field',
  'set_name','set_name_computed','set_proto','set_home_object','define_method',
  'define_method_computed','define_class','define_class_computed','get_array_el',
  'get_array_el2','get_array_el3','get_ref_value','get_super_value','put_array_el',
  'put_ref_value','put_super_value','define_array_el','append','copy_data_properties',
]

function one(source,marker){
  if(source.split(marker).length!==2)throw Error('Unexpected interpreter property integration site: '+marker.slice(0,80))
}

export function stageInterpreterProperties(file){
  let source=readFileSync(file,'utf8')
  if(source.includes('typedef struct QJSPropertyOpcodeState'))throw Error('Unexpected interpreter property integration site: stage already applied')
  one(source,helperMarker)
  one(source,familyStart)
  one(source,familyEnd)

  const start=source.indexOf(familyStart)
  const end=source.indexOf(familyEnd,start)
  if(start<0||end<0||end<=start)throw Error('Unexpected interpreter property family bounds')
  const family=source.slice(start,end)
  for(const opcode of routedOpcodes){
    const marker=`CASE(OP_${opcode}):`
    if(!family.includes(marker))throw Error('Missing interpreter property opcode: '+opcode)
  }
  const cases=[...family.matchAll(/CASE\(OP_([a-zA-Z0-9_]+)\):/g)].map(match=>match[1])
  if(cases.join(',')!==routedOpcodes.join(','))throw Error('Unexpected interpreter property opcode order: '+cases.join(','))

  const helperFamily=family
    .replaceAll('CASE(', 'QJS_PROPERTY_CASE(')
    .replaceAll('BREAK;', 'QJS_PROPERTY_BREAK;')
    .replaceAll('goto exception;', 'goto qjs_property_exception;')

  const helper=`typedef struct QJSPropertyOpcodeState {
    JSContext *ctx;
    JSStackFrame *sf;
    JSVarRef **var_refs;
    const uint8_t *pc;
    JSValue *sp;
    int opcode;
} QJSPropertyOpcodeState;

enum {
    QJS_PROPERTY_CONTINUE,
    QJS_PROPERTY_EXCEPTION,
};

static __attribute__((noinline)) int
JS_ExecutePropertyOpcode(QJSPropertyOpcodeState *state)
{
    JSContext *ctx = state->ctx;
    JSStackFrame *sf = state->sf;
    JSVarRef **var_refs = state->var_refs;
    const uint8_t *pc = state->pc;
    JSValue *sp = state->sp;
    JSValue ret_val;
    int opcode = state->opcode;

#define QJS_PROPERTY_CASE(op) case op
#define QJS_PROPERTY_BREAK goto qjs_property_continue
    switch (opcode) {
${helperFamily}
    default:
        abort();
    }
qjs_property_continue:
    state->pc = pc;
    state->sp = sp;
    return QJS_PROPERTY_CONTINUE;
qjs_property_exception:
    state->pc = pc;
    state->sp = sp;
    return QJS_PROPERTY_EXCEPTION;
#undef QJS_PROPERTY_CASE
#undef QJS_PROPERTY_BREAK
}

`
  const routes=routedOpcodes.map(opcode=>opcode==='get_length'
    ? `#if SHORT_OPCODES\n        CASE(OP_${opcode}):\n#endif`
    : `        CASE(OP_${opcode}):`).join('\n')
  const dispatch=`${routes}
            {
                QJSPropertyOpcodeState property_state = {
                    ctx, sf, var_refs, pc, sp, opcode,
                };
                int property_action = JS_ExecutePropertyOpcode(&property_state);
                pc = property_state.pc;
                sp = property_state.sp;
                if (unlikely(property_action == QJS_PROPERTY_EXCEPTION))
                    goto exception;
            }
            BREAK;

`
  source=source.slice(0,start)+dispatch+source.slice(end)
  source=source.replace(helperMarker,helper+helperMarker)
  writeFileSync(file,source)
}
