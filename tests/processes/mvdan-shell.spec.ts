import {test,expect} from '@playwright/test'

test('shell pipefail preserves command failure and broken-pipe status',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/input':''})
    try{
      const codes=[]
      for(const script of [
        `node -e 'process.exit(7)' | node -e 'process.exit(0)'`,
        `set -o pipefail; node -e 'process.exit(7)' | node -e 'process.exit(0)'`,
        `set -o pipefail; node -e 'process.stdout.write(Buffer.alloc(262144,65))' | node -e 'process.exit(0)'`,
      ])codes.push((await window.sandboxLab.runMvdanShell(kernel,script,{timeoutMs:10000})).code)
      return codes
    }finally{kernel.close()}
  })
  expect(result).toEqual([0,7,141])
})

test('repeated shell startup deadlines release sessions and child resources',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/server.mjs':`import {createServer} from 'node:net';createServer().listen(8128);`})
    try{
      const errors=[]
      for(const timeoutMs of [1,20,80,200,400,1,20,80,200,400]){
        errors.push(await window.sandboxLab.runMvdanShell(kernel,'node /project/server.mjs',{timeoutMs}).then(()=>'',error=>String(error)))
      }
      await kernel.writeText('/project/check.mjs',`import {createServer} from 'node:net';const s=createServer();s.listen(8128,()=>s.close(()=>console.log('recovered')));`)
      const check=await window.sandboxLab.runMvdanShell(kernel,'node /project/check.mjs',{timeoutMs:10000})
      return {errors,code:check.code,stdout:new TextDecoder().decode(check.stdout)}
    }finally{kernel.close()}
  })
  expect(result.errors).toHaveLength(10)
  expect(result.errors.every(error=>error.includes('timed out'))).toBe(true)
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('recovered\n')
})

test('shell handles early pipeline consumers and background wait',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/input':''})
    try{
      const pipeline=await window.sandboxLab.runMvdanShell(kernel,`node -e 'process.stdout.write(Buffer.alloc(262144,65))' | node -e 'console.log("done")'`,{timeoutMs:10000})
      const background=await window.sandboxLab.runMvdanShell(kernel,`node -e 'setTimeout(()=>console.log("first"),100)' & node -e 'console.log("second")' & wait; printf 'finished\\n'`,{timeoutMs:10000})
      return {pipeline:{code:pipeline.code,stdout:new TextDecoder().decode(pipeline.stdout)},background:{code:background.code,stdout:new TextDecoder().decode(background.stdout)}}
    }finally{kernel.close()}
  })
  expect(result.pipeline).toEqual({code:0,stdout:'done\n'})
  expect(result.background.code).toBe(0)
  expect(result.background.stdout.trim().split('\n').sort()).toEqual(['finished','first','second'])
  expect(result.background.stdout.endsWith('finished\n')).toBe(true)
})

test('concurrent shell timeout does not stop another session',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/input':'shared'})
    try{
      const dying=window.sandboxLab.runMvdanShell(kernel,`node -e 'setInterval(()=>{},1000)'`,{timeoutMs:1500}).then(()=>'',error=>String(error))
      const surviving=window.sandboxLab.runMvdanShell(kernel,`node -e 'setTimeout(()=>console.log("survived"),2200)'`,{timeoutMs:7000})
      const [error,run]=await Promise.all([dying,surviving])
      return {error,code:run.code,stdout:new TextDecoder().decode(run.stdout),stderr:new TextDecoder().decode(run.stderr)}
    }finally{kernel.close()}
  })
  expect(result.error).toContain('timed out')
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('survived\n')
  expect(result.stderr).toBe('')
})

test('shell children inherit quoting, cwd, environment and read-only authority',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/input':'kept'})
    try{
      const script=`DEMO=ok node -e 'const fs=require("node:fs");let error;try{fs.writeFileSync("/project/input","changed")}catch(e){error=e.code}console.log(JSON.stringify([process.env.DEMO,process.cwd(),process.argv.slice(1),error]))' "$(printf 'a b')" ""`
      const run=await window.sandboxLab.runMvdanShell(kernel,script,{timeoutMs:7000})
      return {code:run.code,stdout:new TextDecoder().decode(run.stdout),saved:await kernel.readText('/project/input')}
    }finally{kernel.close()}
  })
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(['ok','/project',['a b',''],'EACCES'])
  expect(result.saved).toBe('kept')
})

test('shell timeout cleans up a real child server and preserves its files',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/server.mjs':`import {createServer} from 'node:net';import {writeFileSync} from 'node:fs';createServer().listen(8127,()=>writeFileSync('/project/started','yes'));`})
    try{
      const error=await window.sandboxLab.runMvdanShell(kernel,'node /project/server.mjs',{writable:true,timeoutMs:3000}).then(()=>'',error=>String(error))
      const started=await kernel.readText('/project/started')
      await kernel.writeText('/project/recovery.mjs',`import {createServer} from 'node:net';const server=createServer();server.listen(8127,()=>server.close(()=>console.log('reused')));`)
      const recovery=await kernel.runModule('/project/recovery.mjs',{guestWasm:true,timeoutMs:5000})
      return {error,started,recovery}
    }finally{kernel.close()}
  })
  expect(result.error).toContain('timed out')
  expect(result.started).toBe('yes')
  expect(result.recovery.exitCode,result.recovery.stderr).toBe(0)
  expect(result.recovery.stdout.trim()).toBe('reused')
})

test('mvdan shell runs real QuickJS commands through a binary pipeline',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/input':'shared\n'})
    try{
      const script=`node -e 'process.stdout.write(Buffer.from([0,255,128,65]))' | node -e 'const chunks=[];process.stdin.on("data",b=>chunks.push(b));process.stdin.on("end",()=>console.log(JSON.stringify([...Buffer.concat(chunks)])))'`
      const run=await window.sandboxLab.runMvdanShell(kernel,script,{timeoutMs:10000})
      return {code:run.code,error:run.error,stdout:new TextDecoder().decode(run.stdout),stderr:new TextDecoder().decode(run.stderr)}
    }finally{kernel.close()}
  })
  expect(result).toEqual({code:0,error:'',stdout:'[0,255,128,65]\n',stderr:''})
})

test('mvdan shell redirects into the kernel workspace and reads host edits',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/input':'shared\n'})
    try{
      const run=await window.sandboxLab.runMvdanShell(kernel,'printf "saved\\n" > /project/output; read value < /project/input; printf "%s\\n" "$value"',{writable:true})
      return {code:run.code,error:run.error,stdout:new TextDecoder().decode(run.stdout),saved:await kernel.readText('/project/output')}
    }finally{kernel.close()}
  })
  expect(result).toEqual({code:0,error:'',stdout:'shared\n',saved:'saved\n'})
})

test('hard-stopping the shell preserves workspace files and allows a new shell',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/project/input':'shared\n'})
    try{
      const error=await window.sandboxLab.runMvdanShell(kernel,'printf "kept" > /project/saved; while :; do :; done',{writable:true,timeoutMs:2000}).then(()=>'',error=>String(error))
      const saved=await kernel.readText('/project/saved')
      const next=await window.sandboxLab.runMvdanShell(kernel,'printf "recovered"')
      return {error,saved,code:next.code,stdout:new TextDecoder().decode(next.stdout)}
    }finally{kernel.close()}
  })
  expect(result.error).toContain('timed out')
  expect(result.saved).toBe('kept')
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('recovered')
})
