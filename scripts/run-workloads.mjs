import {spawn} from 'node:child_process'

function command(executable,args){
  return new Promise(resolve=>{
    const child=spawn(executable,args,{stdio:'inherit'})
    child.on('error',error=>{console.error(error);resolve(1)})
    child.on('exit',code=>resolve(code??1))
  })
}
const run=script=>command('npm',['run',script])
for(const script of ['prepare:workloads','build']){
  const status=await run(script)
  if(status)process.exit(status)
}
if(process.argv.includes('--batches')){
  process.exitCode=await command(process.execPath,['scripts/run-workload-batches.mjs'])
}else{
  const tests=await run('test:workloads')
  // Always produce the matrix, even when a browser or an assertion failed.
  const summary=await run('report:workloads')
  process.exitCode=tests||summary
}
