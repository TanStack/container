import {test,expect} from '@playwright/test'

test('compiler-sized binary pipe round trips preserve bytes',async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/echo.mjs':`process.stdin.on('data',chunk=>process.stdout.write(chunk));process.stdout.write('ready\\n');`,
      '/parent.mjs':`
        import {spawn} from 'node:child_process';
        const child=spawn(process.execPath,['/echo.mjs']);
        await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',bytes=>bytes.toString()==='ready\\n'?resolve():reject(Error('Invalid handshake')))});
        const rows=[];
        for(const size of [21941,63099]){
          const input=Buffer.alloc(size);for(let i=0;i<size;i++)input[i]=i%256;
          for(let index=0;index<7;index++){
            const started=performance.now();
            const output=await new Promise((resolve,reject)=>{
              let length=0;const chunks=[];
              const receive=chunk=>{chunks.push(chunk);length+=chunk.length;if(length>=size){child.stdout.off('data',receive);resolve(Buffer.concat(chunks))}};
              child.stdout.on('data',receive);
              child.stdin.write(input,error=>{if(error){child.stdout.off('data',receive);reject(error)}});
            });
            const ms=performance.now()-started;
            if(!input.equals(output))throw Error('Corrupt round trip');
            rows.push({size,index,ms});
          }
        }
        const closed=new Promise(resolve=>child.once('close',resolve));child.stdin.end();await closed;
        console.log(JSON.stringify(rows));
      `,
    },{cooperative:true,maxBytes:256*1024*1024})
    try{return await kernel.runModule('/parent.mjs',{guestWasm:true,webAPIs:true,timeoutMs:30000,maxBytes:256*1024*1024})}
    finally{kernel.close()}
  })
  await info.attach('compiler-pipe-cost.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const rows=JSON.parse(result.stdout)
  expect(rows).toHaveLength(14)
  expect(rows.filter((row:any)=>row.size===63099)).toHaveLength(7)
})
