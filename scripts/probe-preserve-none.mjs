import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const compiler=process.env.CC??'cc'
const fixture=resolve('fixtures/wasm-interpreter/preserve-none-repro.c')
const directory=mkdtempSync(join(tmpdir(),'preserve-none-diagnostic-'))
const run=(command,args)=>{
  const r=spawnSync(command,args,{encoding:'utf8',timeout:60000,maxBuffer:1024*1024,
    env:{...process.env,ASAN_OPTIONS:'abort_on_error=1:symbolize=0',UBSAN_OPTIONS:'halt_on_error=1:print_stacktrace=1'}})
  return {command,args,status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,error:String(r.error??'')}
}
const version=run(compiler,['--version']),rows=[]
if(version.status!==0)throw Error(version.stderr||version.error)
for(const optimization of ['O0','O1'])for(const sanitizer of ['address','address,undefined'])for(const preserveNone of [false,true]){
  const binary=join(directory,`${optimization}-${sanitizer.replace(',','-')}-${preserveNone}`)
  const build=run(compiler,[`-${optimization}`,'-g','-fno-omit-frame-pointer',`-fsanitize=${sanitizer}`,
    '-Wall','-Wextra','-Werror','-Wno-unused-parameter',`-DUSE_PRESERVE_NONE=${+preserveNone}`,fixture,'-o',binary])
  const execution=build.status===0?run(binary,[]):null
  const status=build.status!==0?'build-failure':execution.status===77?'unsupported':execution.status===0&&execution.stdout==='42\n'?'pass':'failure'
  rows.push({optimization,sanitizer,preserveNone,status,build,execution})
  console.log(optimization,sanitizer,preserveNone?'preserve_none':'default ABI',status)
}
writeFileSync('reports/preserve-none-diagnostic.json',JSON.stringify({scope:'Native compiler calling-convention diagnostic, not guest engine coverage; default ABI is a control, not a runtime patch',compiler:version.stdout,fixtureSHA256:createHash('sha256').update(readFileSync(fixture)).digest('hex'),directory,rows},null,2)+'\n')
if(rows.some(row=>row.status!=='pass'))process.exitCode=1
