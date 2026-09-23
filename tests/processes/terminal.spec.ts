import {test,expect} from '@playwright/test'
test('owner terminal delivers Vitest raw shortcut bytes without echo and reports real dimensions',async({page})=>{
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async()=>{
  const source=`import process from 'node:process';import tty from 'node:tty';import {emitKeypressEvents} from 'node:readline';
   emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);
   process.stdin.on('keypress',(text,key)=>{
    console.log(JSON.stringify({key:key.name,raw:process.stdin.isRaw,tty:[tty.isatty(0),tty.isatty(1)],size:process.stdout.getWindowSize()}));
    process.stdin.setRawMode(false);process.stdin.removeAllListeners('keypress');process.stdin.pause();
   });console.log('ready');`
  const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source}),child=await kernel.spawn('node',['/main.mjs'],{webAPIs:true,timeoutMs:5000,terminal:{columns:100,rows:30}})
  let output=''
  try{
   for(;;){const event=await child.next();if(!event||event.type==='exit')break;if(event.type==='stdout'){const text=new TextDecoder().decode(event.bytes);output+=text;if(text.includes('ready'))await child.write('r')}}
   return {output,result:await child.wait()}
  }finally{await child.dispose();kernel.close()}
 })
 expect(result.result.exitCode,result.result.stderr).toBe(0)
 expect(result.output.trim().split('\n')).toEqual(['ready',JSON.stringify({key:'r',raw:true,tty:[true,true],size:[100,30]})])
})
