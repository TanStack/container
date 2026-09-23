import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {spawnSync} from 'node:child_process'
const engine=JSON.parse(readFileSync('public/quickjs-als-wasm/build.json'))
const directory=engine.guestWasm.directory
if(!directory.includes('/quickjs-guest-wasm-'))throw Error('Unexpected prepared source path')
const qjs=join(directory,'quickjs'),exe=join(directory,'stacktrace-allocation-asan')
const args=['-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-D_GNU_SOURCE','-DCONFIG_VERSION="spike"','-I'+qjs,resolve('fixtures/stacktrace-allocation-native.c'),...['quickjs','dtoa','libregexp','libunicode','cutils'].map(n=>join(qjs,n+'.c')),'-lm','-o',exe]
const build=spawnSync('cc',args,{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})
const run=build.status===0?spawnSync(exe,[],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):null
const report={engine,args,build:{status:build.status,stderr:build.stderr},run:run&&{status:run.status,signal:run.signal,stdout:run.stdout,stderr:run.stderr,error:String(run.error??'')}}
writeFileSync('reports/stacktrace-allocation-asan.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.run??report.build,null,2));if(build.status!==0||run?.status!==0)process.exitCode=1
