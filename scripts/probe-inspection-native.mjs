import {readFileSync,writeFileSync,mkdtempSync,realpathSync,cpSync,copyFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {setup} from '../fixtures/inspection-native.mjs'
import {typeSetup} from '../fixtures/inspection-types.mjs'
import {propertySetup} from '../fixtures/inspection-properties.mjs'
import {constructorSetup} from '../fixtures/inspection-constructors.mjs'
import {stageConstructorMetadata} from './stage-constructor-metadata.mjs'

const engine=JSON.parse(readFileSync('public/quickjs-als-wasm/build.json'))
const originalQjs=realpathSync(join(engine.guestWasm.directory,'quickjs'))
const directory=mkdtempSync(join(tmpdir(),'quickjs-inspection-native-'))
const qjs=join(directory,'quickjs')
cpSync(originalQjs,qjs,{recursive:true})
// Reconstruct the pre-fix baseline in the private copy, even after browser
// artifacts include the fixes. Never reverse patches in the source checkout.
for(const [name,expectedHash] of Object.entries(engine.allocationSafetyPatches??{})){
  const path=resolve('patches',name)
  if(createHash('sha256').update(readFileSync(path)).digest('hex')!==expectedHash)throw Error('Engine allocation patch provenance mismatch')
  const reversed=spawnSync('patch',['-R','-p1','-d',directory,'-i',path],{encoding:'utf8'})
  if(reversed.status!==0)throw Error(reversed.stdout+reversed.stderr)
}
const unpatched=process.argv.includes('--unpatched')
const scopeOnly=process.argv.includes('--scope-only')
const patches=unpatched?[]:[resolve('patches/quickjs-scope-resolution-oom.patch'),...(!scopeOnly?[resolve('patches/quickjs-bound-function-oom.patch')]:[])]
for(const patchPath of patches){
  const patch=spawnSync('patch',['-p1','-d',directory,'-i',patchPath],{encoding:'utf8'})
  if(patch.status!==0)throw Error(patch.stdout+patch.stderr)
}
const source=join(directory,'probe.js'),exe=join(directory,'probe')
if(engine.inspection){
  if(createHash('sha256').update(readFileSync('scripts/stage-constructor-metadata.mjs')).digest('hex')!==engine.inspection.constructorMetadataSHA256)throw Error('Constructor metadata differs from engine build')
  copyFileSync('src/sandbox/guest-inspect.c',join(qjs,'qjs-inspect.h'))
}else stageConstructorMetadata(join(qjs,'quickjs.c'))
const allSetup=typeSetup+propertySetup+constructorSetup+setup
writeFileSync(source,allSetup)
const inputs=['scripts/probe-inspection-native.mjs','scripts/stage-constructor-metadata.mjs','fixtures/inspection-native.c','fixtures/inspection-native.mjs','fixtures/inspection-types.mjs','fixtures/inspection-properties.mjs','fixtures/inspection-constructors.mjs','src/sandbox/guest-inspect.c',...patches,...['quickjs','dtoa','libregexp','libunicode','cutils'].map(name=>join(qjs,name+'.c'))]
const hashes=Object.fromEntries(inputs.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]))
const args=['-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-D_GNU_SOURCE','-DCONFIG_VERSION="spike"','-I'+qjs,'-I'+resolve('src/sandbox'),resolve('fixtures/inspection-native.c'),...['dtoa','libregexp','libunicode','cutils'].map(n=>join(qjs,n+'.c')),'-lm','-o',exe]
const options={encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024}
const build=spawnSync('cc',args,options)
const oracle=spawnSync(process.execPath,['--expose-internals','--input-type=commonjs','-e',`(async()=>{globalThis.inspection=require('internal/test/binding').internalBinding('util');inspection.types={...require('node:util').types};delete inspection.types.isCryptoKey;delete inspection.types.isKeyObject;globalThis.moduleNamespace=await import('data:text/javascript,export const x=1');${allSetup};console.log(run());checkRetained();})().catch(error=>{console.error(error);process.exitCode=1})`],options)
const run=build.status===0?spawnSync(exe,[source,'comparison'],{...options,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):null
const allocation=run?.status===0?spawnSync(exe,[source,'allocation'],{...options,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):null
const factory=build.status===0?spawnSync(exe,[source,'factory'],{...options,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):null
const factorySites=build.status===0?spawnSync(exe,[source,'factory-sites'],{...options,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):null
const matched=oracle.status===0&&run?.status===0&&oracle.stdout===run.stdout
const differences=[]
function compare(expected,actual,path='$'){
  if(Object.is(expected,actual))return
  if(expected!==null&&actual!==null&&typeof expected==='object'&&typeof actual==='object'){
    for(const key of new Set([...Object.keys(expected),...Object.keys(actual)]))compare(expected[key],actual[key],path+'.'+key)
  }else differences.push({path,expected,actual})
}
if(oracle.status===0&&run?.status===0)compare(JSON.parse(oracle.stdout),JSON.parse(run.stdout))
const summary=x=>x&&({status:x.status,signal:x.signal,stdout:x.stdout,stderr:x.stderr,error:String(x.error??'')})
const report={scope:'Native constructor, type, property, proxy, promise and collection introspection foundation, not yet integrated into the browser engine or util.inspect',patches,allocationBudget:{maxExtraBytes:131072,stepBytes:512},factoryAllocationBudget:{maxExtraBytes:65536,stepBytes:256},interruptionCheckpoints:[16,128,1024,10000],propertyInterruptionCheckpoints:[16,128,1024,10000],node:process.version,engine,hashes,args,build:summary(build),oracle:summary(oracle),run:summary(run),allocation:summary(allocation),factory:summary(factory),factorySites:summary(factorySites),matched,differences}
writeFileSync(unpatched?'reports/inspection-native-oom-baseline.json':scopeOnly?'reports/inspection-native-bound-oom-baseline.json':'reports/inspection-native.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({matched,differences,build:summary(build),run:run&&{status:run.status,signal:run.signal,stderr:run.stderr,error:String(run.error??'')},allocation:summary(allocation),factory:summary(factory),factorySites:summary(factorySites)},null,2))
if(!matched||allocation?.status!==0||factory?.status!==0||factorySites?.status!==0||run.stderr||allocation.stderr||factory.stderr||factorySites.stderr)process.exitCode=1
