import {test,expect} from '@playwright/test'
test('stat polling, shared listener removal and promise watcher cancellation',async({page})=>{
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async()=>{
  const source=`import fs from 'node:fs';import {watch} from 'node:fs/promises';
   fs.writeFileSync('/file','a');
   const polling=await new Promise(resolve=>{
    const listener=(current,previous)=>{fs.unwatchFile('/file',listener);resolve([current.size,previous.size])};
    const watcher=fs.watchFile('/file',{interval:5},listener);watcher.unref().ref();
    setTimeout(()=>fs.writeFileSync('/file','longer'),15);
   });
   const controller=new AbortController(),iterator=watch('/file',{signal:controller.signal});
   const next=iterator.next();fs.writeFileSync('/file','changed');const event=await next;
   const pending=iterator.next();controller.abort();let abort;try{await pending}catch(error){abort=error.name}
   console.log(JSON.stringify({polling,event:event.value.eventType,abort}));`
  const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
  try{return await kernel.runModule('/main.mjs',{writable:true,webAPIs:true,timeoutMs:5000})}finally{kernel.close()}
 })
 expect(result.exitCode,result.stderr).toBe(0)
 expect(JSON.parse(result.stdout)).toEqual({polling:[6,1],event:'change',abort:'AbortError'})
})

test('filesystem-root and project-root directory watches report relative child names',async({page})=>{
 await page.goto('/sandbox.html')
 const result=await page.evaluate(async()=>{
  const source=`import fs from 'node:fs';
   fs.mkdirSync('/project');
   const observe=(path,write)=>new Promise((resolve,reject)=>{const watcher=fs.watch(path,(event,filename)=>{watcher.close();resolve({event,filename})});watcher.on('error',reject);write()});
   const root=await observe('/',()=>fs.mkdirSync('/root-child'));
   const project=await observe('/project',()=>fs.writeFileSync('/project/file.ts','value'));
   console.log(JSON.stringify({root,project}));`
  const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
  try{return await kernel.runModule('/main.mjs',{writable:true,webAPIs:true,timeoutMs:5000})}finally{kernel.close()}
 })
 expect(result.exitCode,result.stderr).toBe(0)
 expect(JSON.parse(result.stdout)).toEqual({root:{event:'rename',filename:'root-child'},project:{event:'rename',filename:'file.ts'}})
})
