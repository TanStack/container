import {test,expect} from 'vitest'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
// @ts-expect-error Native source staging helper is JavaScript.
import {stageVMModuleCompile,stageVMModuleRuntime} from '../scripts/stage-vm-module-compile.mjs'
test('deferred VM module linking is explicit and idempotent',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'vm-module-stage-')),'quickjs.c')
  writeFileSync(path,'if (js_resolve_module(ctx, m) < 0)\n            goto fail1;')
  stageVMModuleCompile(path)
  const first=readFileSync(path,'utf8')
  expect(first).toContain('JS_EVAL_FLAG_COMPILE_ONLY')
  expect(first).toContain('VM_MODULE_DEFER_LINK')
  stageVMModuleCompile(path)
  expect(readFileSync(path,'utf8')).toBe(first)
})
test('dynamic import callbacks are rooted on bytecode and staging is idempotent',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'vm-import-stage-')),'quickjs.c')
  writeFileSync(path,readFileSync('.toolchains/quickjs-emscripten/vendor/quickjs/quickjs.c'))
  stageVMModuleRuntime(path)
  const first=readFileSync(path,'utf8')
  expect(first).toContain('JSGCObjectHeader header;\n    JSValue vm_import_callback;')
  expect(first).toContain('JS_MarkValue(rt, b->vm_import_callback, mark_func)')
  expect(first).toContain('JS_FreeValueRT(rt, b->vm_import_callback)')
  expect(first).toContain('JS_EnqueueJob(ctx, vm_import_job, 5, callback_args)')
  stageVMModuleRuntime(path)
  expect(readFileSync(path,'utf8')).toBe(first)
})
