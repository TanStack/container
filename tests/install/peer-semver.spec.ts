import {test,expect} from '@playwright/test'
import {npmProject} from '../fixtures/npm-project'

test('worker accepts npm peer placement and atomically rejects an incompatible peer range',async({page,context})=>{
  const valid=npmProject(),invalid=npmProject()
  valid.lock.packages['node_modules/parent'].peerDependencies={child:'^1.0.0'}
  invalid.lock.packages['node_modules/parent'].peerDependencies={child:'^2.0.0'}
  valid.files['/package-lock.json']=JSON.stringify(valid.lock)
  invalid.files['/package-lock.json']=JSON.stringify(invalid.lock)
  await context.route('https://registry.npmjs.org/**',route=>route.fulfill({body:valid.archives[route.request().url()],headers:{'access-control-allow-origin':'*'}}))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({valid,invalid})=>{
    const accepted=new window.sandboxLab.WorkerKernel(valid)
    const rejected=new window.sandboxLab.WorkerKernel(invalid)
    try{
      await accepted.install()
      const execution=await accepted.runModule('/entry.cjs',{guestWasm:true})
      const before=await rejected.snapshot()
      let error=''
      try{await rejected.install()}catch(failure){error=String(failure)}
      return {execution,error,before,after:await rejected.snapshot()}
    }finally{accepted.close();rejected.close()}
  },{valid:valid.files,invalid:invalid.files})
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(result.execution.stdout).toBe('42 1\n')
  expect(result.error).toContain('peer dependency child@1.0.0 does not satisfy ^2.0.0')
  expect(result.after).toEqual(result.before)
})
