import {expect,test} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const source=`
import process from 'node:process';import os from 'node:os';
const previousExcludeNetwork=process.report.excludeNetwork;
process.report.excludeNetwork=true;
const header=process.report.getReport().header;
process.report.excludeNetwork=previousExcludeNetwork;
const cpu=os.cpus()[0],parallel=os.availableParallelism();
const viteDefaultMax=Math.max(1,parallel-1);
const vitestProcessingConcurrency=Math.min(20,parallel);
console.log(JSON.stringify({
  reportShape:[header.reportVersion,header.event,header.trigger].every(Boolean),
  identityConsistent:header.processId===process.pid&&header.cwd===process.cwd()&&header.nodejsVersion===process.version&&header.arch===process.arch&&header.platform===process.platform,
  commandLine:Array.isArray(header.commandLine),components:header.componentVersions.node===process.versions.node,
  release:header.release.name===process.release.name,cpuShape:typeof cpu.model==='string'&&typeof cpu.speed==='number'&&['user','nice','sys','idle','irq'].every(name=>typeof cpu.times[name]==='number'),
  cpuCount:os.cpus().length,parallel,viteDefaultMax,vitestProcessingConcurrency,
  virtual:header.osName==='BrowserSandbox'&&cpu.model==='Virtual CPU'&&header.wordSize===32
}));`

test('virtual report and CPU policy satisfy Rollup Vite and Vitest source sites',async({page},info)=>{
  const native=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000})
  expect(native.status,native.stderr).toBe(0)
  expect(JSON.parse(native.stdout)).toMatchObject({reportShape:true,identityConsistent:true,commandLine:true,components:true,release:true,cpuShape:true})

  await page.goto('/sandbox.html')
  const results=await page.evaluate(async source=>{
    const values=[]
    for(const guestWasm of [false,true]){
      const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
      try{values.push(await kernel.runModule('/main.mjs',{guestWasm}))}finally{kernel.close()}
    }
    return values
  },source)
  await info.attach('native-report-shape.json',{body:native.stdout,contentType:'application/json'})
  for(const result of results){
    expect(result.exitCode,result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({reportShape:true,identityConsistent:true,commandLine:true,components:true,release:true,cpuShape:true,cpuCount:1,parallel:1,viteDefaultMax:1,vitestProcessingConcurrency:1,virtual:true})
  }
})
