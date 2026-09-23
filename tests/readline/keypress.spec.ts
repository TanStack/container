import {test,expect} from '@playwright/test'
test('Vitest watch keypress API accepts piped shortcuts without claiming a terminal',async({page})=>{
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async()=>{
  const source=`import readline from 'node:readline';import {PassThrough} from 'node:stream';import tty from 'node:tty';
   const input=new PassThrough(),rl=readline.createInterface({input,escapeCodeTimeout:50});
   readline.emitKeypressEvents(input,rl);const keys=[];
   input.on('keypress',(text,key)=>keys.push({name:key.name,ctrl:key.ctrl}));
   input.write('r'+String.fromCharCode(3));rl.close();input.removeAllListeners('keypress');
   console.log(JSON.stringify({keys,terminal:tty.isatty(0),raw:typeof process.stdin.setRawMode,columns:typeof process.stdout.columns}));`
  const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
  try{return await kernel.runModule('/main.mjs',{webAPIs:true,timeoutMs:5000})}finally{kernel.close()}
 })
 expect(result.exitCode,result.stderr).toBe(0)
 expect(JSON.parse(result.stdout)).toEqual({keys:[{name:'r',ctrl:false},{name:'c',ctrl:true}],terminal:false,raw:'undefined',columns:'undefined'})
})
