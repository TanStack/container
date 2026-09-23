import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true]){
  test(`kernel host ceilings | guest WASM ${guestWasm} | explicit larger budget and unchanged defaults`,async({page},info)=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async guestWasm=>{
      const kernel=new window.sandboxLab.WorkerKernel({}, {maxBytes:128*1024*1024,timeoutMs:40000})
      try{
        let denied=''
        try{await kernel.execute('console.log("escaped")',{guestWasm,maxBytes:129*1024*1024})}catch(error){denied=String(error)}
        const explicit=await kernel.execute('const bytes=new Uint8Array(70*1024*1024);bytes[bytes.length-1]=42;console.log(bytes.length,bytes[bytes.length-1]);',{guestWasm,maxBytes:96*1024*1024})
        const defaults=await kernel.execute('const bytes=new Uint8Array(20*1024*1024);console.log("escaped");',{guestWasm})
        const recovery=await kernel.execute('console.log(42)',{guestWasm})
        return {denied,explicit,defaults,recovery}
      }finally{kernel.close()}
    },guestWasm)
    await info.attach('kernel-limits.json',{body:JSON.stringify(result),contentType:'application/json'})
    expect(result.denied).toContain('Invalid execution limits')
    expect(result.explicit.exitCode,result.explicit.stderr).toBe(0)
    expect(result.explicit.stdout).toBe('73400320 42\n')
    expect(result.defaults.exitCode).not.toBe(0)
    expect(result.defaults.stdout).toBe('')
    expect(result.recovery.stdout).toBe('42\n')
  })
  test(`kernel host ceilings | guest WASM ${guestWasm} | time ceiling, original limits and diagnostic null`,async({page},info)=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async guestWasm=>{
      const limited=new window.sandboxLab.WorkerKernel({}, {timeoutMs:500})
      const original=new window.sandboxLab.WorkerKernel()
      try{
        const denied=[]
        for(const [kernel,options] of [[limited,{timeoutMs:501}],[original,{maxBytes:65*1024*1024}]] as const){
          try{await kernel.execute('console.log("escaped")',{guestWasm,...options})}catch(error){denied.push(String(error))}
        }
        const deadline=await limited.execute('while(true){}',{guestWasm})
        const nullError=await original.execute('throw null',{guestWasm,diagnostics:true})
        const recovery=await limited.execute('console.log(42)',{guestWasm})
        return {denied,deadline,nullError,recovery}
      }finally{limited.close();original.close()}
    },guestWasm)
    await info.attach('kernel-limits.json',{body:JSON.stringify(result),contentType:'application/json'})
    expect(result.denied).toHaveLength(2)
    for(const message of result.denied)expect(message).toContain('Invalid execution limits')
    expect(result.deadline.exitCode).not.toBe(0)
    expect(result.deadline.stderr).toMatch(/interrupted|timed out/i)
    expect(result.nullError.stderr).toBe('Error: null')
    expect(result.nullError.diagnostics?.failure?.isNull).toBe(true)
    expect(result.nullError.diagnostics?.failure?.memory).toContain('memory allocated')
    expect(result.recovery.stdout).toBe('42\n')
  })
}
