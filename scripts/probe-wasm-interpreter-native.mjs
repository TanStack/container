import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
const build=JSON.parse(readFileSync('public/wasm-interpreter-probe/build.json','utf8'))
const directory=dirname(build.nativeCLI)
if(!directory.includes('/web-container-wasm-build-'))throw Error('Unexpected build directory')
const sources=readdirSync(join(directory,'source')).filter(name=>name.endsWith('.c')).sort().map(name=>join(directory,'source',name))
const binary=join(directory,'probe-asan')
const optimization=process.argv.includes('--o0')?'-O0':'-O1'
const sanitizer=process.argv.includes('--address-only')?'address':'address,undefined'
const args=[optimization,'-g','-fno-omit-frame-pointer','-fsanitize='+sanitizer,
  '-Dd_m3MaxLinearMemoryPages=128','-Dd_m3MaxNativeStack=131072','-Dd_m3HasExceptionHandling=0',
  '-I'+join(directory,'source'),resolve('fixtures/wasm-interpreter/probe.c'),resolve('fixtures/wasm-interpreter/native-test.c'),
  ...sources,'-lm','-o',binary]
const compile=spawnSync('cc',args,{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024})
if(compile.status!==0)throw Error(compile.stderr+'\n'+compile.error)
const run=spawnSync(binary,[resolve('public/wasm-interpreter-probe/controls.wasm')],{
  encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,
  env:{...process.env,ASAN_OPTIONS:'abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1:print_stacktrace=1'},
})
const report={build,compilerArgs:args,compilerWarnings:compile.stderr,status:run.status,signal:run.signal,stdout:run.stdout,stderr:run.stderr,error:String(run.error??'')}
const suffix=process.argv.includes('--o0')?'-o0':process.argv.includes('--address-only')?'-address-only':''
writeFileSync('reports/wasm-interpreter-asan'+suffix+'.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({status:report.status,signal:report.signal,stdout:report.stdout,stderr:report.stderr.slice(-5000)},null,2))
if(run.status!==0)process.exitCode=1
