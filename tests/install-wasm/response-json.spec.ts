import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
const source=`const values=[{answer:42},null,'🦊',false,0,[],undefined,()=>{},Symbol('x'),1n];const results=[];
const check=async(args)=>{try{const r=Response.json(...args);results.push([r.status,r.statusText,[...r.headers],await r.text()])}catch(e){results.push(e.name)}};
for(const value of values)await check([value]);
for(const init of [{status:201,statusText:'Created'},{headers:{'Content-Type':'custom','X-Probe':'yes'}},{status:204},{status:205},{status:304},{status:0},{status:600},{status:200.9},{status:65736},{statusText:'bad\\nstatus'},null,42])await check([{ok:true},init]);
const circular={};circular.self=circular;await check([circular]);await check([]);
const original=Response.json({a:1}),clone=original.clone();results.push([await original.json(),await clone.json(),original.bodyUsed,clone.bodyUsed]);
console.log(JSON.stringify(results));`
test('Response.json matches Node serialization, headers, status and cloning',async({page})=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/probe.mjs':source})
    try{return await kernel.runModule('/probe.mjs',{webAPIs:true})}finally{kernel.close()}
  },source)
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(node.stdout))
})
