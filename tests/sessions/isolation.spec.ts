import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true])for(const stop of ['cancel','deadline','heap'] as const){
  test(`${guestWasm?'WASM bridge':'default engine'}: independent sandboxes retain files and same-port servers after ${stop}`,async({page},info)=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({guestWasm,stop})=>{
      const {WorkerKernel,WorkerHTTP}=window.sandboxLab
      const serverSource=`import http from 'node:http';import fs from 'node:fs';http.createServer((req,res)=>res.end(fs.readFileSync('/message','utf8'))).listen(8296,()=>console.log('ready'));`
      const a=new WorkerKernel({'/message':'sandbox A','/server.mjs':serverSource})
      const b=new WorkerKernel({'/message':'sandbox B','/server.mjs':serverSource})
      try{
        const servers=await Promise.all([a,b].map(kernel=>kernel.spawn('node',['/server.mjs'],{lifetime:'session',guestWasm})))
        const ready=await Promise.all(servers.map(server=>server.next()))
        const read=async(kernel:InstanceType<typeof WorkerKernel>)=>{
          const response=await new WorkerHTTP(kernel,8296).fetch(new Request('http://sandbox.local/'))
          return {status:response.status,text:await response.text()}
        }
        const initial=await Promise.all([read(a),read(b)])
        const source=stop==='cancel'?'console.log("busy");setInterval(()=>{},10)':stop==='heap'?'console.log("busy");new ArrayBuffer(64*1024*1024)':'console.log("busy");for(;;){}'
        const child=await a.spawn('node',['--input-type=module','-e',source],{lifetime:'session',guestWasm,timeoutMs:1000,maxBytes:16*1024*1024})
        const pendingReady=child.next()
        // Submit B's work without waiting for A's process event to be delivered.
        await b.writeText('/message','sandbox B edited')
        const during=await read(b)
        const childReady=await pendingReady
        const killed=stop==='cancel'?await child.kill('SIGTERM'):undefined
        const stopped=await child.wait()
        await child.dispose()
        const after=await Promise.all([read(a),read(b)])
        a.close()
        await b.writeText('/message','sandbox B after A closed')
        const afterClose=await read(b)
        const file=await b.readText('/message')
        await servers[1].dispose()
        return {ready,initial,childReady,during,killed,stopped,after,afterClose,file}
      }finally{a.close();b.close()}
    },{guestWasm,stop})
    await info.attach('sandbox-isolation.json',{body:JSON.stringify(result),contentType:'application/json'})
    expect(result.ready.map(event=>event?.type)).toEqual(['stdout','stdout'])
    expect(result.childReady?.type).toBe('stdout')
    expect(result.initial).toEqual([{status:200,text:'sandbox A'},{status:200,text:'sandbox B'}])
    expect(result.during).toEqual({status:200,text:'sandbox B edited'})
    if(stop==='cancel'){
      expect(result.killed).toBe(true)
      expect(result.stopped.signal).toBe('SIGTERM')
    }else{
      expect(result.stopped.exitCode).toBe(1)
      expect(result.stopped.stderr).toMatch(stop==='heap'?/out of memory/i:/interrupted|timed out/)
    }
    expect(result.after).toEqual([{status:200,text:'sandbox A'},{status:200,text:'sandbox B edited'}])
    expect(result.afterClose).toEqual({status:200,text:'sandbox B after A closed'})
    expect(result.file).toBe('sandbox B after A closed')
  })
}
