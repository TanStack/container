import {readFileSync,writeFileSync,readdirSync,cpSync,mkdtempSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {resolveWasm3Source} from './fixture-toolchains.mjs'
const upstream=resolveWasm3Source()
const run=(command,args,options={})=>{
  const result=spawnSync(command,args,{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,...options})
  return {command,args,status:result.status,signal:result.signal,error:String(result.error??''),stdout:result.stdout,stderr:result.stderr}
}
const revision=run('git',['-C',upstream,'rev-parse','HEAD'])
if(revision.status||revision.stdout.trim()!=='5fe766c933c7595d728d6172bb1a197607d85b4e')throw Error('Unexpected Wasm3 revision')
const status=run('git',['-C',upstream,'status','--porcelain'])
if(status.status||status.stdout.trim())throw Error('Wasm3 checkout is not clean')
const directory=mkdtempSync(join(tmpdir(),'wasm-compiler-native-'))
for(const name of ['source','extra','test'])cpSync(join(upstream,name),join(directory,name),{recursive:true})
const patch=resolve('patches/wasm3-iterative-blocks.patch')
const applied=run('patch',['-p1','-d',directory,'-i',patch])
if(applied.status)throw Error(applied.stderr)
const wasiPatch=resolve('patches/wasm3-wasi-unused-arguments.patch')
const wasiApplied=run('patch',['-p1','-d',directory,'-i',wasiPatch])
if(wasiApplied.status)throw Error(wasiApplied.stderr)
const host=JSON.parse(readFileSync('public/wasm-interpreter-probe/build.json','utf8')).nativeCLI
const rows=[]
for(const slots of [0,1]){
  const binary=join(directory,'wasm3-slots'+slots)
  console.log('Build native ASan compiler, 32-bit slots:',slots)
  const build=run('cc',['-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-D_GNU_SOURCE','-Dd_m3HasWASI','-Dd_m3Use32BitSlots='+slots,'-I'+join(directory,'source'),
    ...readdirSync(join(directory,'source')).filter(name=>name.endsWith('.c')).map(name=>join(directory,'source',name)),join(upstream,'platforms/app/main.c'),'-lm','-o',binary])
  console.log('Build status:',build.status)
  const regression=build.status===0?run('python3',['run-regression-test.py','--exec',binary,'--host',host],{cwd:join(directory,'test'),timeout:300000,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):undefined
  console.log('Regression status:',regression?.status,regression?.stdout.slice(-700),build.stderr)
  rows.push({slots,build,regression})
}
writeFileSync('reports/wasm-compiler-native.json',JSON.stringify({directory,scope:'Pinned upstream Wasm3 with iterative compiler and explicit unused WASI argument annotations, native AddressSanitizer; not the combined QuickJS engine',revision:revision.stdout.trim(),patchSHA256:createHash('sha256').update(readFileSync(patch)).digest('hex'),wasiPatchSHA256:createHash('sha256').update(readFileSync(wasiPatch)).digest('hex'),rows},null,2)+'\n')
if(rows.some(row=>row.build.status||row.regression?.status!==0))process.exitCode=1
