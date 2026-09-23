import {readFileSync,writeFileSync} from 'node:fs'

export function stageRequireESM(path){
  let source=readFileSync(path,'utf8')
  const replace=(before,after)=>{if(source.split(before).length!==2)throw Error('Unexpected require facade stage site');source=source.replace(before,after)}
  replace('    JSValue module_ns;','    JSValue module_ns;\n    JSValue require_ns;')
  replace('    m->module_ns = JS_UNDEFINED;','    m->module_ns = JS_UNDEFINED;\n    m->require_ns = JS_UNDEFINED;')
  replace('    JS_MarkValue(rt, m->module_ns, mark_func);','    JS_MarkValue(rt, m->module_ns, mark_func);\n    JS_MarkValue(rt, m->require_ns, mark_func);')
  replace('    JS_FreeValueRT(rt, m->module_ns);','    JS_FreeValueRT(rt, m->module_ns);\n    JS_FreeValueRT(rt, m->require_ns);')
  const marker='int JS_AddIntrinsicEval(JSContext *ctx)\n{'
  if(source.split(marker).length!==2)throw Error('Unexpected require ESM installation site')
  source=source.replace(marker,`static JSValue qjs_require_esm(JSContext *, JSValueConst, int, JSValueConst *);\n${marker}\n    if (JS_SetPropertyStr(ctx, ctx->global_obj, "__qjsRequireESM",\n        JS_NewCFunction(ctx, qjs_require_esm, "requireESM", 1)) < 0) return -1;`)
  source=source.replace('const char *hidden[] = {','const char *hidden[] = { "__qjsRequireESM",')
  source+='\n'+readFileSync(new URL('../src/sandbox/guest-require-esm.c',import.meta.url),'utf8')
  writeFileSync(path,source)
}
