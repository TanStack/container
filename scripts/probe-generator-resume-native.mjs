import {readFileSync,writeFileSync,mkdtempSync,cpSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {stageCallDepth} from './stage-call-depth.mjs'
import {stageInterpreterFrames} from './stage-interpreter-frames.mjs'
import {stageGeneratorResume} from './stage-generator-resume.mjs'
import {stageOpcodePatterns} from './stage-opcode-patterns.mjs'
import {cases} from '../fixtures/generator-resume-cases.mjs'

const baseline=process.argv.includes('--baseline')
const sanitize=process.argv.includes('--sanitize')
if(process.argv.slice(2).some(arg=>!['--baseline','--sanitize'].includes(arg)))throw Error('Only --baseline and --sanitize are supported')
const directory=mkdtempSync(join(tmpdir(),'generator-resume-native-'))
const source=resolve('.toolchains/quickjs-emscripten/vendor/quickjs')
const qjs=join(directory,'quickjs')
cpSync(source,qjs,{recursive:true})
const c=join(qjs,'quickjs.c'),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const sourceHash=hash(readFileSync(c))
const stageHash=hash(readFileSync('scripts/stage-generator-resume.mjs'))
const opcodePatternsHash=hash(readFileSync('scripts/stage-opcode-patterns.mjs'))
stageOpcodePatterns(c)
stageCallDepth(c)
stageInterpreterFrames(c)
if(!baseline)stageGeneratorResume(c)
const exe=join(directory,'probe')
const args=['-O1','-g','-D_GNU_SOURCE','-DCONFIG_VERSION="generator-resume-spike"','-I'+qjs,
  resolve('fixtures/generator-resume-native.c'),...['quickjs','dtoa','libregexp','libunicode','cutils'].map(name=>join(qjs,name+'.c')),'-lm','-o',exe]
if(sanitize)args.unshift('-fsanitize=address,undefined','-fno-omit-frame-pointer','-fno-sanitize-recover=all')
const options={encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024}
const summary=result=>({status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr,error:String(result.error??'')})
const compiler=process.env.CC||'cc'
const build=spawnSync(compiler,args,options)
const rows=[]
if(build.status===0)for(const [index,item] of cases.entries()){
  const program='JSON.stringify(('+item.source+'))'
  const input=join(directory,'case-'+index+'.js')
  writeFileSync(input,program)
  const oracle=spawnSync(process.execPath,['--input-type=module','-e','console.log('+program+')'],{...options,timeout:5000})
  const actual=spawnSync(exe,[input],{...options,timeout:5000})
  const matched=oracle.status===0&&actual.status===0&&oracle.stdout===actual.stdout&&!actual.stderr
  rows.push({name:item.name,sourceSHA256:hash(program),matched,oracle:summary(oracle),actual:summary(actual)})
  console.log(JSON.stringify({name:item.name,matched,status:actual.status,error:actual.stderr.slice(0,500)}))
}
const report={scope:'Native direct intrinsic generator continuation comparison, not browser coverage',baseline,sanitize,
  sourceHash,stagedHash:hash(readFileSync(c)),stageHash,opcodePatternsHash,
  compiler,sdkRoot:process.env.SDKROOT??null,args,build:summary(build),rows}
writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n')
console.log('GENERATOR_RESUME_NATIVE_OUTPUT='+directory)
if(build.status!==0){console.error(build.stderr);process.exitCode=1}
else if(rows.length!==cases.length||rows.some(row=>!row.matched))process.exitCode=1
