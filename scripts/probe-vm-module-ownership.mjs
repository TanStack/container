import {mkdtempSync,cpSync,writeFileSync,readFileSync,appendFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {stageOpcodePatterns} from './stage-opcode-patterns.mjs'
import {stageVMModuleCompile,stageVMModuleDispatch,stageVMModuleRuntime} from './stage-vm-module-compile.mjs'
import {stageVMDynamicImport} from './stage-vm-dynamic-import.mjs'

const directory=mkdtempSync(join(tmpdir(),'vm-module-ownership-'))
const runtime=process.argv.includes('--runtime')
const guest=process.argv.includes('--guest')||runtime
const qjs=join(directory,'quickjs')
cpSync(resolve('.toolchains/quickjs-emscripten/vendor/quickjs'),qjs,{recursive:true})
stageOpcodePatterns(join(qjs,'quickjs.c'))
stageVMModuleCompile(join(qjs,'quickjs.c'))
if(runtime)stageVMModuleRuntime(join(qjs,'quickjs.c'))
else if(guest){stageVMModuleDispatch(join(qjs,'quickjs.c'));stageVMDynamicImport(join(qjs,'quickjs.c'));appendFileSync(join(qjs,'quickjs.c'),'\n'+readFileSync('fixtures/vm-module-guest-native.inc','utf8'))}
const guestAPI=runtime?join(directory,'guest-api.js'):resolve('fixtures/vm-module-guest-api.js')
if(runtime)writeFileSync(guestAPI,readFileSync('src/sandbox/guest-vm-modules.js','utf8').replace('export function createVMModules','function createVMModules')+'\nconst {SourceTextModule,SyntheticModule}=createVMModules(vmNative,context=>context.vmModules);')
const executable=join(directory,'probe')
const options={encoding:'utf8',timeout:120000,maxBuffer:1024*1024}
const compiler=process.env.CC||'cc'
const build=spawnSync(compiler,['-O1','-g','-D_GNU_SOURCE','-DCONFIG_VERSION="vm-module-ownership"','-I'+qjs,resolve(guest?'fixtures/vm-module-guest-runner.c':'fixtures/vm-module-ownership-native.c'),...['quickjs','dtoa','libregexp','libunicode','cutils'].map(name=>join(qjs,name+'.c')),'-lm','-o',executable],options)
const run=build.status===0?spawnSync(executable,guest?[guestAPI,resolve('fixtures/vm-module-guest-cases.js')]:[],{...options,timeout:10000}):null
writeFileSync(join(directory,'report.json'),JSON.stringify({scope:'Native module ownership spike only',build,run},null,2))
console.log(JSON.stringify({directory,buildStatus:build.status,runStatus:run?.status,stdout:run?.stdout,stderr:build.stderr+(run?.stderr??'')}))
if(build.status!==0||run?.status!==0)process.exitCode=1
