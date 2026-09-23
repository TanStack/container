import {spawn} from 'node:child_process'
import {mkdirSync,readdirSync,existsSync} from 'node:fs'

// Separate launches are evidence for bounded suites, not a fix for the
// independently reproduced WebKit page/context lifecycle failure.
const batches={
  runtime:['symlinks.spec.ts','filesystem.spec.ts','module-loader.spec.ts','kernel-runtime.spec.ts'],
  packages:['packages.spec.ts','apps.spec.ts','browser-runtimes.spec.ts'],
  streams:['streams.spec.ts','immediates.spec.ts'],
  core:['node-core.spec.ts','guest-vm.spec.ts','context-primitives.spec.ts','context-globals.spec.ts','portable-core.spec.ts','buffer-utf8.spec.ts','resolution.spec.ts'],
  contexts:['vm-contexts.spec.ts','allocator.spec.ts'],
}
const selected=Object.values(batches).flat().sort()
const discovered=readdirSync('tests/workloads',{recursive:true}).filter(file=>file.endsWith('.spec.ts')).sort()
if(new Set(selected).size!==selected.length||JSON.stringify(selected)!==JSON.stringify(discovered))throw Error('Workload batch inventory does not cover every spec exactly once. Update the explicit batches before running.')
if(process.argv.includes('--list')){
  for(const [name,files] of Object.entries(batches))console.log(name+': '+files.join(', '))
}else{
  const stamp=new Date().toISOString().replaceAll(':','-')+'-'+process.pid
  const directory='reports/batched/'+stamp
  mkdirSync(directory,{recursive:true})
  let active,interrupted=false
  // Playwright handles SIGINT by closing its browsers and web server and
  // writing interrupted results. SIGTERM can leave its Vite child running.
  const stop=()=>{interrupted=true;active?.kill('SIGINT')}
  process.on('SIGINT',stop);process.on('SIGTERM',stop)
  const run=(args,env=process.env)=>new Promise(resolve=>{
    const child=spawn(process.execPath,args,{stdio:'inherit',env});active=child
    child.once('error',error=>{console.error(error);resolve(1)})
    child.once('exit',code=>{active=undefined;resolve(code??1)})
  })
  const reports=[]
  let status=0
  try{
    for(const [name,files] of Object.entries(batches)){
      if(interrupted){status=130;break}
      const output=directory+'/'+name+'.json'
      const code=await run(['node_modules/@playwright/test/cli.js','test','--config=playwright.workloads.config.ts',...files,'--output=test-results/workloads-batched/'+stamp+'/'+name,'--reporter=list,json'],{...process.env,PLAYWRIGHT_JSON_OUTPUT_FILE:output})
      if(existsSync(output))reports.push(output)
      if(code){status=code;break}
    }
    if(reports.length&&!interrupted){
      const summary=await run(['scripts/summarize-workloads.mjs',reports.join(','),directory+'/workload'])
      status||=summary
      console.log('Report: '+directory+'/workload-summary.md')
    }
    if(reports.length!==Object.keys(batches).length)console.error('Incomplete batch run. This is not a complete workload matrix.')
  }finally{
    process.off('SIGINT',stop);process.off('SIGTERM',stop)
  }
  process.exitCode=interrupted?130:status
}
