import {test,expect} from '@playwright/test'

test('package imports preserve scope, conditions, patterns, and target boundaries',async({page})=>{
  await page.goto('/sandbox.html')
  const report=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/package.json':JSON.stringify({imports:{'#root':'./root.js'}}),'/root.js':'export default 99',
      '/node_modules/example/package.json':JSON.stringify({type:'module',main:'index.js',imports:{
        '#value':{require:'./require.js',import:'./import.js'},'#utils/*':'./utils/*.js',
        '#blocked':null,'#escape':'./../outside.js','#external':'dependency',
      }}),
      '/node_modules/example/import.js':'export default 3',
      '/node_modules/example/require.js':'module.exports=7',
      '/node_modules/example/utils/double.js':'export default value=>value*2',
      '/node_modules/dependency/package.json':'{"main":"index.js"}',
      '/node_modules/dependency/index.js':'module.exports=11',
      '/node_modules/outside.js':'export default 123',
      '/main.js':'import "example"',
      '/node_modules/example/index.js':`import value from '#value';import double from '#utils/double';import external from '#external';console.log(JSON.stringify([value,require('#value'),double(value),external]));`,
    })
    try{
      const passed=await kernel.run('/main.js')
      const failures=[]
      for(const name of ['#root','#blocked','#escape','#unknown']){
        await kernel.writeText('/node_modules/example/index.js',`import value from '${name}';console.log(value)`)
        try{await kernel.run('/main.js');failures.push('unexpected success')}catch(error){failures.push(String(error))}
      }
      return {passed,failures}
    }finally{kernel.close()}
  })
  expect(report.passed.exitCode,report.passed.stderr).toBe(0)
  expect(JSON.parse(report.passed.stdout)).toEqual([3,7,6,11])
  for(const error of report.failures)expect(error).toMatch(/not defined|Invalid package import target/)
})

test('browser mappings select alternate files and disable declared Node-only imports',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const k=new window.sandboxLab.WorkerKernel({
      '/main.js':`import value from 'mapped';console.log(value)`,
      '/node_modules/mapped/package.json':JSON.stringify({main:'main.js',browser:{'./main.js':'./browser.js','./node.js':'./web.js','node:crypto':false}}),
      '/node_modules/mapped/main.js':`throw Error('Node entry selected')`,
      '/node_modules/mapped/browser.js':`import value from './node.js';import crypto from 'node:crypto';export default value+Object.keys(crypto).length`,
      '/node_modules/mapped/node.js':`throw Error('Node implementation selected')`,
      '/node_modules/mapped/web.js':`export default 42`,
    })
    try{return await k.run('/main.js')}finally{k.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('42')
})
