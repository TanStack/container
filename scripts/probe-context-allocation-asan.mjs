import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {spawnSync} from 'node:child_process'

const source=resolve(process.argv[2]??'/private/tmp/quickjs-als-engine-spike')
const directory=mkdtempSync(join(tmpdir(),'web-container-context-asan-'))
const executable=join(directory,'context-allocation')
const fingerprint=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const patchSHA256=fingerprint('patches/quickjs-engine.patch'),fixtureSHA256=fingerprint('fixtures/context-allocation-native.c')
const args=['-g','-O1','-fsanitize=address','-fno-omit-frame-pointer','-D_GNU_SOURCE','-DCONFIG_VERSION="spike"','-I',join(source,'vendor/quickjs'),resolve('fixtures/context-allocation-native.c'),
  ...['quickjs','dtoa','libregexp','libunicode','cutils'].map(file=>join(source,'vendor/quickjs',file+'.c')),'-o',executable]
const build=spawnSync('cc',args,{encoding:'utf8',timeout:120000})
const run=build.status===0?spawnSync(executable,[],{encoding:'utf8',timeout:60000}):undefined
const report={generatedAt:new Date().toISOString(),source,executable,compiler:'cc',patchSHA256,fixtureSHA256,args,build:{status:build.status,signal:build.signal,stdout:build.stdout,stderr:build.stderr},
  run:run?{status:run.status,signal:run.signal,stdout:run.stdout,stderr:run.stderr}:undefined}
writeFileSync('reports/context-allocation-asan.json',JSON.stringify(report,null,2)+'\n')
console.log(run?.stdout??build.stdout)
if(build.status!==0||run?.status!==0){console.error(run?.stderr??build.stderr);process.exitCode=1}
