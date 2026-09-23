import {test,expect} from '@playwright/test'

test('worker kernel runtime modules load deployed assets and retain ALS across imports',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/entry.mjs':`import {AsyncLocalStorage} from 'node:async_hooks';
        import {createRequire} from 'node:module';
        const require=createRequire(import.meta.url);const als=new AsyncLocalStorage();
        await Promise.all([3,7].map(value=>als.run(value,async()=>{
          await new Promise(resolve=>setTimeout(resolve,value));
          const name='./value.cjs';const loaded=await import(name);
          if(als.getStore()!==value||loaded.default!==require(name))throw Error('context or module identity mismatch');
        })));
        console.log(require('./value.cjs').value);`,
      '/value.cjs':'exports.value=42',
    })
    try{return await kernel.runModule('/entry.mjs',{webAPIs:true})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('42')
})

test('worker kernel runtime modules preserve failed ESM resolution and recover',async({page})=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/static.mjs':`import './missing.mjs'`,
      '/dynamic.mjs':`await import('./missing.mjs')`,
      '/builtin.mjs':`import 'node:unsupported_fixture_builtin'`,
      '/recover.cjs':`console.log(42)`,
    })
    try{
      const results=[]
      for(const entry of ['/static.mjs','/dynamic.mjs','/builtin.mjs']){
        results.push(await kernel.runModule(entry))
        results.push(await kernel.runModule('/recover.cjs'))
      }
      return results
    }finally{kernel.close()}
  })
  for(let index=0;index<3;index++){
    expect(results[index*2].exitCode).toBe(1)
    expect(results[index*2].stderr).toContain(index===2?'Unsupported Node builtin: node:unsupported_fixture_builtin':'Cannot find module: /missing.mjs')
    expect(results[index*2].stderr).not.toContain('emsc')
    expect(results[index*2+1].exitCode).toBe(0)
    expect(results[index*2+1].stdout.trim()).toBe('42')
  }
})
