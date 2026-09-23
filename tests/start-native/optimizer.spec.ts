import {test,expect} from '@playwright/test'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {createServer} from 'vite'

test('native Start dependency discovery before and after hydration',async({page},info)=>{
  const root=await mkdtemp(resolve('fixtures/native-start-optimizer-'))
  for(const name of ['vite.config.ts','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/about.tsx']){
    const path=resolve(root,name)
    await mkdir(dirname(path),{recursive:true})
    await writeFile(path,await readFile('fixtures/start-basic/'+name))
  }
  await writeFile(resolve(root,'package.json'),JSON.stringify({name:'native-start-optimizer',private:true,type:'module'}))
  const server=await createServer({root,configFile:resolve(root,'vite.config.ts'),cacheDir:resolve(root,'.vite'),server:{host:'127.0.0.1',port:0},clearScreen:false})
  const rows:unknown[]=[]
  try{
    await server.listen()
    const optimizer=server.environments.client.depsOptimizer!
    await optimizer.scanProcessing
    rows.push({phase:'after scan',optimized:Object.keys(optimizer.metadata.optimized),discovered:Object.keys(optimizer.metadata.discovered),options:server.environments.client.config.optimizeDeps})
    const address=server.httpServer!.address()
    if(!address||typeof address==='string')throw Error('No native server address')
    const start=performance.now()
    await page.goto(`http://127.0.0.1:${address.port}`)
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible({timeout:30000})
    rows.push({phase:'hydrated',ms:performance.now()-start,optimized:Object.keys(optimizer.metadata.optimized),discovered:Object.keys(optimizer.metadata.discovered)})
  }finally{
    await mkdir(info.outputDir,{recursive:true})
    await writeFile(info.outputPath('native-optimizer.json'),JSON.stringify(rows,null,2))
    await info.attach('native-optimizer.json',{body:JSON.stringify(rows,null,2),contentType:'application/json'})
    await server.close()
  }
})
