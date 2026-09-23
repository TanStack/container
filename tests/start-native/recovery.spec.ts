import {test,expect} from '@playwright/test'
import {mkdir,mkdtemp,readFile,writeFile,symlink} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {createServer} from 'vite'
import {captureHMR} from '../fixtures/hmr-events'

test('native Start shared-package syntax error and repair',async({page},info)=>{
  const hmrEvents:unknown[]=[]
  const socketEvents:unknown[]=[]
  page.on('websocket',socket=>{
    socket.on('framereceived',event=>socketEvents.push({at:Date.now(),url:socket.url(),payload:String(event.payload)}))
  })
  // Vite ignores test-results directories, so keep generated sources outside it.
  const root=await mkdtemp(resolve('fixtures/native-start-control-')),logs:string[]=[]
  await info.attach('project-path.txt',{body:root,contentType:'text/plain'})
  const put=async(path:string,value:string)=>{await mkdir(dirname(resolve(root,path)),{recursive:true});await writeFile(resolve(root,path),value)}
  for(const name of ['vite.config.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/about.tsx'])await put(name,await readFile('fixtures/start-basic/'+name,'utf8'))
  await put('package.json',JSON.stringify({name:'native-start-control',private:true,type:'module',workspaces:['packages/*']}))
  await put('packages/shared/package.json',JSON.stringify({name:'@probe/shared',version:'1.0.0',type:'module',exports:'./index.js'}))
  const shared=(heading:string,message:string)=>`export const heading=${JSON.stringify(heading)}; export const message=${JSON.stringify(message)}`
  await put('packages/shared/index.js',shared('Workspace heading','TanStack Start rendered inside the browser runtime.'))
  const original=await readFile(resolve(root,'src/routes/index.tsx'),'utf8')
  await put('src/routes/index.tsx',"import {heading,message} from '@probe/shared'\n"+original.replace("message: 'TanStack Start rendered inside the browser runtime.'",'message').replace('<h1>Bare-bones Start</h1>','<h1>{heading}</h1>'))
  await mkdir(resolve(root,'node_modules/@probe'),{recursive:true})
  await symlink(resolve(root,'packages/shared'),resolve(root,'node_modules/@probe/shared'))
  page.on('console',message=>logs.push(message.type()+': '+message.text()))
  page.on('pageerror',error=>logs.push(error.message))
  const server=await createServer({root,configFile:resolve(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0},clearScreen:false})
  try{
    await server.listen()
    const address=server.httpServer!.address()
    if(!address||typeof address==='string')throw Error('No server address')
    const origin=`http://127.0.0.1:${address.port}`
    await page.goto(origin)
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()
    await captureHMR(page,hmrEvents)
    await page.locator('#start-count').click()
    await expect(page.locator('#start-count')).toHaveText('Count: 1')
    await put('packages/shared/index.js',shared('Edited workspace','Updated server workspace message'))
    await expect(page.locator('h1')).toHaveText('Edited workspace')
    await put('packages/shared/index.js','export const heading = ;')
    await expect(page.getByText('Parse failure: Expression expected',{exact:false})).toBeVisible({timeout:10000})
    await info.attach('broken-preview.txt',{body:await page.locator('body').innerText(),contentType:'text/plain'})
    // Wait for the failed route to settle, rather than repairing while the
    // circular-import reload is still replacing the document.
    await expect.poll(()=>page.evaluate(()=>{
      return (window as any).__TSR_ROUTER__?.state.matches.some((match:any)=>match.status==='error')??false
    })).toBe(true)
    await info.attach('broken-router-state.json',{body:JSON.stringify(await page.evaluate(()=>{
      return (window as any).__TSR_ROUTER__?.state.matches.map((match:any)=>({id:match.id,status:match.status,error:String(match.error)}))
    })),contentType:'application/json'})
    await put('packages/shared/index.js',shared('Repaired workspace','Repaired server workspace message'))
    let repaired=''
    await expect.poll(async()=>{
      const response=await page.request.get(origin);repaired=await response.text()
      return response.status()===200&&repaired.includes('Repaired server workspace message')
    },{timeout:30000}).toBe(true)
    await info.attach('repaired-ssr.html',{body:repaired,contentType:'text/html'})
    await expect.soft(page.locator('h1')).toHaveText('Repaired workspace',{timeout:30000})
    if(process.env.START_RECOVERY_ROUTE_EDIT==='1'){
      // Keep the failed automatic recovery above. This is a separate user edit,
      // not a runtime reload policy or an alternative acceptance path.
      const route=await readFile(resolve(root,'src/routes/index.tsx'),'utf8')
      await put('src/routes/index.tsx',route.replace('loader: () => getRuntimeInfo(),','loader: async () => await getRuntimeInfo(),'))
      await expect.soft(page.locator('h1')).toHaveText('Repaired workspace',{timeout:30000})
      await info.attach('route-edit-recovery.txt',{body:await page.locator('body').innerText(),contentType:'text/plain'})
      await page.reload()
      await expect(page.locator('h1')).toHaveText('Repaired workspace',{timeout:30000})
      await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()
      await info.attach('manual-reload-recovery.txt',{body:await page.locator('body').innerText(),contentType:'text/plain'})
    }
  }finally{
    await info.attach('hmr-events.json',{body:JSON.stringify(hmrEvents),contentType:'application/json'})
    await info.attach('websocket-events.json',{body:JSON.stringify(socketEvents),contentType:'application/json'})
    await info.attach('browser-log.json',{body:JSON.stringify(logs),contentType:'application/json'})
    await server.close()
  }
})
