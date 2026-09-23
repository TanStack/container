import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

// Prerequisites only. This does not enable lazy compilation or disable validation.
export function stageWasmLazyCompilation(directory){
  const files=new Map(['m3_function.h','m3_compile.c','m3_exec.h'].map(name=>[name,readFileSync(join(directory,name),'utf8')]))
  const replace=(name,from,to)=>{
    const source=files.get(name)
    if(source.split(from).length!==2)throw Error('Unexpected lazy compilation integration site: '+name)
    files.set(name,source.replace(from,to))
  }
  replace('m3_function.h','    pc_t               compiled;',`    pc_t               compiled;
    bool               compilationFailed; /* Stable state, no borrowed error pointer. */`)
  replace('m3_compile.c','M3Result CompileFunction (IM3Function io_function)\n{',`M3Result CompileFunction (IM3Function io_function)
{
    if (io_function->compilationFailed)
        return "previous WASM function compilation failed";
    if (io_function->compiled) return m3Err_none;`)
  replace('m3_compile.c',`        if (vr) {
            return vr;
        }`,`        if (vr) {
            io_function->compilationFailed = true;
            return vr;
        }`)
  replace('m3_compile.c','    io_function->compiled      = pc;','    /* Publish the callable only after every fallible allocation succeeds. */')
  replace('m3_compile.c',`        _throwifnull(io_function->constants);
    }

} _catch:

    ReleaseCompilationCodePage(o);`,`        _throwifnull(io_function->constants);
    }
    io_function->compiled = pc;

} _catch:

    if (result) io_function->compilationFailed = true;
    ReleaseCompilationCodePage(o);`)
  for(const [operation,target] of [['Compile','Call'],['CompileReturnCall','ReturnCall']]){
    replace('m3_exec.h',`d_m3Op(${operation})
{
    rewrite_op(op_${target});
`, `d_m3Op(${operation})
{
`)
    replace('m3_exec.h',`        // patch up compiled pc and call rewritten op_${target}
        *((void**)--_pc) = (void*)(function->compiled);`,`        // Publish both operands only after compilation has succeeded.
        *((void**)--_pc) = (void*)(function->compiled);
        rewrite_op(op_${target});`)
  }
  // Resolve every anchor before touching the private staging directory.
  for(const [name,source] of files)writeFileSync(join(directory,name),source)
}
