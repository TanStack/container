import {mkdtempSync,cpSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {stageWasmLazyCompilation} from './stage-wasm-lazy-compilation.mjs'

const directory=mkdtempSync(join(tmpdir(),'wasm-lazy-native-'))
cpSync('.toolchains/wasm3/source',directory,{recursive:true})
stageWasmLazyCompilation(directory)
const edit=(name,from,to)=>{
  const path=join(directory,name),source=readFileSync(path,'utf8')
  if(source.split(from).length!==2)throw Error('Native test hook anchor changed: '+name)
  writeFileSync(path,source.replace(from,to))
}
// Test-only allocation observation and deterministic failure points. The staged
// compiler and interpreter are unchanged apart from these hooks.
edit('m3_core.c','void* m3_Malloc_Impl (size_t i_size)\n{\n    return calloc','void* test_real_malloc (size_t i_size)\n{\n    return calloc')
edit('m3_core.c','void m3_Free_Impl (void* io_ptr)','void test_real_free (void* io_ptr)')
edit('m3_core.c','void* m3_Realloc_Impl (void* i_ptr, size_t i_newSize, size_t i_oldSize)\n{\n    if (M3_UNLIKELY(i_newSize == i_oldSize)) {\n        return i_ptr;\n    }\n\n    void* newPtr = realloc','void* test_real_realloc (void* i_ptr, size_t i_newSize, size_t i_oldSize)\n{\n    if (M3_UNLIKELY(i_newSize == i_oldSize)) {\n        return i_ptr;\n    }\n\n    void* newPtr = realloc')
edit('m3_core.c','void* m3_CopyMem (const void* i_from, size_t i_size)\n{','extern int test_fail_copy(void);\nvoid* m3_CopyMem (const void* i_from, size_t i_size)\n{\n    if (test_fail_copy()) return NULL;')
edit('m3_compile.c','            EmitWord(o->page, i_operation);','            extern void test_record_call(pc_t,int);\n            if(i_operation==op_Compile||i_operation==op_CompileReturnCall) test_record_call(GetPagePC(o->page),i_operation==op_Compile?1:2);\n            EmitWord(o->page, i_operation);')
const files=['m3_bind','m3_code','m3_compile','m3_core','m3_deterministic','m3_env','m3_exec','m3_function','m3_info','m3_module','m3_parse','m3_validate'].map(name=>join(directory,name+'.c'))
const output=join(directory,'lazy-test')
for(const [command,args] of [[process.env.CC??'cc',['-std=c11','-O1','-Dd_m3HasExceptionHandling=0','-Dd_m3CanTailCall=1','-I',directory,resolve('tests/native/wasm-lazy-compilation.c'),...files,'-lm','-o',output]],[output,[]]]){
  const result=spawnSync(command,args,{encoding:'utf8',timeout:60000})
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'')
  if(result.status!==0)throw result.error??Error(`${command} failed (${result.status}, ${result.signal})`)
}
