import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {fileURLToPath} from 'node:url'
import {basename,isAbsolute,join} from 'node:path'
import {lstatSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'

// Usage: node scripts/test-sdk.mjs [--project=chromium|firefox|webkit]
// Each invocation retains a fresh SDK and test output directory. Stages are
// sequential, and only the final stage launches a browser test runner.
const root=fileURLToPath(new URL('../',import.meta.url))
const args=process.argv.slice(2)
if(args.length>1||args.length===1&&!/^--project=(chromium|firefox|webkit)$/.test(args[0])){
  console.error('Usage: node scripts/test-sdk.mjs [--project=chromium|firefox|webkit]')
  process.exit(1)
}

let activeChild,interrupted
const handlers=new Map()
for(const signal of ['SIGINT','SIGTERM','SIGHUP']){
  const handler=()=>{
    interrupted??=signal
    activeChild?.kill(signal)
  }
  handlers.set(signal,handler)
  process.on(signal,handler)
}

class StageFailure extends Error {
  constructor(stage,code,signal){
    super(`${stage} failed (${signal??`exit ${code}`})`)
    this.code=code;this.signal=signal
  }
}

function run(stage,arguments_,{line,env=process.env}={}){
  if(interrupted)throw new StageFailure(stage,null,interrupted)
  console.log(`SDK test stage: ${stage}`)
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,arguments_,{
      cwd:root,env,stdio:['inherit',line?'pipe':'inherit','inherit'],
    })
    activeChild=child
    let lines
    if(line){
      child.stdout.pipe(process.stdout,{end:false})
      lines=createInterface({input:child.stdout})
      lines.on('line',line)
    }
    child.once('error',error=>{
      lines?.close()
      if(activeChild===child)activeChild=undefined
      reject(error)
    })
    child.once('close',(code,signal)=>{
      lines?.close()
      if(activeChild===child)activeChild=undefined
      if(code!==0||signal||interrupted)reject(new StageFailure(stage,code,interrupted??signal))
      else resolve()
    })
  })
}

let failure
try{
  const outputs=[]
  await run('build',['scripts/build-sdk.mjs'],{line:value=>{
    if(value.startsWith('SDK_OUTPUT='))outputs.push(value.slice('SDK_OUTPUT='.length))
  }})
  if(outputs.length!==1)throw new Error('Successful build must report exactly one SDK_OUTPUT directory')
  const output=outputs[0]
  if(!isAbsolute(output)||!basename(output).startsWith('browser-sandbox-sdk-'))throw new Error('Unexpected SDK_OUTPUT path')
  const stat=lstatSync(output)
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('SDK_OUTPUT must be a real directory')
  await run('verify',['scripts/verify-sdk.mjs',output])
  await run('npm package acceptance',['scripts/test-sdk-package.mjs',output])
  await run('external types consumer',['scripts/test-sdk-types.mjs',output])
  await run('build profile, asset helper and verifier unit tests',['--test','tests/sdk-build-profiles.test.mjs','tests/sdk-verifier.test.mjs','tests/sdk-assets.test.mjs'])
  await run('framework acceptance discovery',['scripts/discover-sdk-frameworks.mjs'])
  const results=mkdtempSync(join(tmpdir(),'browser-sandbox-sdk-tests-'))
  console.log('SDK_TEST_OUTPUT='+results)
  await run('browser consumers',[
    'node_modules/@playwright/test/cli.js','test','--config=playwright.sdk.config.ts',
    '--trace=on','--reporter=list','--output='+results,...args,
  ],{env:{...process.env,SDK_OUTPUT:output}})
  await run('packaged framework consumers',[
    'node_modules/@playwright/test/cli.js','test','--config=playwright.sdk-frameworks.config.ts',
    '--trace=on','--reporter=list','--output='+join(results,'frameworks'),...args,
  ],{env:{...process.env,SDK_OUTPUT:output}})
  console.log('SDK test stages passed. SDK_OUTPUT='+output)
}catch(error){
  failure=error
  console.error(error instanceof Error?error.message:String(error))
}finally{
  for(const [signal,handler] of handlers)process.removeListener(signal,handler)
}

const signal=interrupted??failure?.signal
if(signal)process.kill(process.pid,signal)
else if(failure)process.exitCode=Number.isInteger(failure.code)&&failure.code>0?failure.code:1
