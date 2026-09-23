import {test,expect} from '@playwright/test'

test('repeated VM work, Start SSR, cancellation, and idle recovery',async({page},info)=>{
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(String(error)))
  page.on('crash',()=>errors.push('Page crashed'))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const cycles=[]
    for(let i=0;i<3;i++){
      const io=await window.sandboxLab.runCombinedIO()
      const start=await window.sandboxLab.runCombinedStart()
      const workspace=new window.sandboxLab.Workspace({files:{'/main.mjs':`
        console.log('started');await new Promise(resolve=>setTimeout(resolve,60000));`}})
      const cancelled=await workspace.executeInVM('/main.mjs',{
        engine:'quickjs-als-asyncify',onOutput:()=>workspace.close(),
      })
      workspace.close()
      if(cancelled.exitCode!==1||!cancelled.stderr.includes('Workspace closed'))throw Error('Cancellation failed')
      cycles.push({io,start,cancelled})
    }
    return {userAgent:navigator.userAgent,cycles}
  })
  // Completion alone missed a real post-run WebKit memory failure. This is a
  // liveness check only; scripts/probe-memory.mjs supplies the separate RSS gate.
  await page.waitForTimeout(20000)
  const recovery=await page.evaluate(()=>window.sandboxLab.runCombinedIO())
  expect(result.cycles).toHaveLength(3)
  expect(errors).toEqual([])
  await info.attach('desktop-lifecycle.json',{body:JSON.stringify({result,recovery}),contentType:'application/json'})
})
