import {readFileSync,writeFileSync} from 'node:fs'
import {stageVMDynamicImport} from './stage-vm-dynamic-import.mjs'

// Private embedder flag, only the VM ownership spike passes it. Normal eval
// and the existing module loader keep their original eager resolution path.
export function stageVMModuleCompile(path){
  let source=readFileSync(path,'utf8')
  const before='if (js_resolve_module(ctx, m) < 0)\n            goto fail1;'
  const after='if (!((flags & JS_EVAL_FLAG_COMPILE_ONLY) && (flags & (1 << 8))) && js_resolve_module(ctx, m) < 0)\n            goto fail1; /* VM_MODULE_DEFER_LINK */'
  if(source.includes(after))return
  if(source.split(before).length!==2)throw Error('Unexpected module compile resolution site')
  source=source.replace(before,after)
  writeFileSync(path,source)
}

/** Dispatch only imports belonging to VM handles, preserving the host loader. */
export function stageVMModuleDispatch(path){
  let source=readFileSync(path,'utf8')
  if(source.includes('/* VM_MODULE_OWNED_DISPATCH */'))return
  const declaration='/* return NULL in case of exception (e.g. module could not be loaded) */\nstatic JSModuleDef *js_host_resolve_imported_module'
  if(source.split(declaration).length!==2)throw Error('Unexpected VM module dispatch declaration')
  source=source.replace(declaration,'static JSModuleDef *vm_probe_resolve(JSContext *, const char *, const char *, int *);\n'+declaration)
  const site='    JSAtom module_name;\n\n    if (!rt->module_normalize_func) {'
  if(source.split(site).length!==2)throw Error('Unexpected VM module dispatch site')
  source=source.replace(site,'    JSAtom module_name;\n    int vm_handled;\n    JSModuleDef *vm_module = vm_probe_resolve(ctx, base_cname, cname1, &vm_handled);\n    if (vm_handled) return vm_module; /* VM_MODULE_OWNED_DISPATCH */\n\n    if (!rt->module_normalize_func) {')
  writeFileSync(path,source)
}

export function stageVMModuleRuntime(path){
  stageVMModuleCompile(path);stageVMModuleDispatch(path);stageVMDynamicImport(path)
  let source=readFileSync(path,'utf8')
  if(source.includes('/* VM_MODULE_RUNTIME */'))return
  const replace=(from,to)=>{if(source.split(from).length!==2)throw Error('Unexpected VM runtime installation site');source=source.replace(from,to)}
  replace('int JS_AddIntrinsicEval(JSContext *ctx)\n{','void VMProbeInstall(JSContext *ctx);\nint JS_AddIntrinsicEval(JSContext *ctx)\n{\n    VMProbeInstall(ctx); /* VM_MODULE_RUNTIME */')
  replace('    compiler = JS_GetPropertyStr(child, child->global_obj, "__qjsCompileScript");','    compiler = JS_GetPropertyStr(child, child->global_obj, "__qjsCompileScript");\n    if (!JS_IsException(compiler)) {\n        JSValue api = JS_GetPropertyStr(child, child->global_obj, "vmNative");\n        if (JS_SetPropertyStr(child, compiler, "vmModules", api) < 0) goto fail;\n    }')
  replace('const char *hidden[] = { "__qjsCreateContext", "__qjsCompileScript",','const char *hidden[] = { "vmNative", "__qjsCreateContext", "__qjsCompileScript",')
  source+='\n'+readFileSync(new URL('../fixtures/vm-module-guest-native.inc',import.meta.url),'utf8')
  writeFileSync(path,source)
}
