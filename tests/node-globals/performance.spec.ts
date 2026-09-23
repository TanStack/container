import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const body=`
import {performance as imported} from 'node:perf_hooks';
const result=[performance===imported,typeof performance.now()==='number',Number.isFinite(performance.timeOrigin)];
const before=performance.now();await new Promise(resolve=>setTimeout(resolve,5));result.push(performance.now()>=before);
performance.clearMarks();performance.clearMeasures();
performance.mark('start',{startTime:2});imported.mark('end',{startTime:7});
performance.measure('duration','start','end');
result.push(imported.getEntriesByName('duration').map(entry=>[entry.entryType,entry.startTime,entry.duration]));
imported.clearMarks('start');result.push(performance.getEntriesByName('start').length);
console.log(JSON.stringify(result));`

for(const guestWasm of [false,true])for(const webAPIs of [false,true])test(`performance global: wasm=${guestWasm}, webAPIs=${webAPIs}`,async({page},info)=>{
  const oracle=spawnSync(process.execPath,['--input-type=module','-e',body],{encoding:'utf8',timeout:10000,env:{...process.env,FORCE_COLOR:'0'}})
  expect(oracle.status,oracle.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async({body,guestWasm,webAPIs})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':body})
    try{
      const first=await kernel.runModule('/main.mjs',{guestWasm,webAPIs})
      await kernel.writeText('/second.mjs',`import {performance as imported} from 'node:perf_hooks';console.log(JSON.stringify([performance===imported,performance.getEntries().length]));`)
      const second=await kernel.runModule('/second.mjs',{guestWasm,webAPIs})
      return {first,second}
    }finally{kernel.close()}
  },{body,guestWasm,webAPIs})
  await info.attach('performance.json',{body:JSON.stringify({oracle:oracle.stdout,...results}),contentType:'application/json'})
  expect(results.first.exitCode,results.first.stderr).toBe(0)
  expect(results.first.stdout).toBe(oracle.stdout)
  expect(results.second.exitCode,results.second.stderr).toBe(0)
  expect(results.second.stdout).toBe('[true,0]\n')
})
