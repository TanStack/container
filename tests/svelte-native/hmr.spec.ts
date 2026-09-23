import {test,expect} from '@playwright/test'
import {mkdtempSync,cpSync,symlinkSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
test('pinned SvelteKit native HMR resets component state without reloading the document',async({page},info)=>{
  const fixture=resolve('fixtures/install-sveltekit-wasm'),root=mkdtempSync(join(tmpdir(),'svelte-native-hmr-'))
  for(const file of ['package.json','vite.config.js','svelte.config.js','src'])cpSync(join(fixture,file),join(root,file),{recursive:true})
  symlinkSync(join(fixture,'node_modules'),join(root,'node_modules'),'dir')
  const vite=join(fixture,'node_modules/vite/dist/node/index.js')
  const {createServer}=await import(vite)
  const previousCwd=process.cwd();process.chdir(root)
  const server=await createServer({root,server:{host:'127.0.0.1',port:0}})
  try{
    await server.listen()
    await page.goto(server.resolvedUrls.local[0])
    await expect(page.locator('main')).toHaveAttribute('data-hydrated','true')
    await page.locator('#count').click();await expect(page.locator('#count')).toHaveText('Count: 1')
    await page.evaluate(()=>(window as any).hmrDocumentMarker='same-document')
    const file=join(root,'src/routes/+page.svelte')
    writeFileSync(file,readFileSync(file,'utf8').replace('Installed SvelteKit','Edited SvelteKit'))
    await expect(page.locator('h1')).toHaveText('Edited SvelteKit')
    await expect(page.locator('#count')).toHaveText('Count: 0')
    expect(await page.evaluate(()=>(window as any).hmrDocumentMarker)).toBe('same-document')
    await info.attach('native-hmr.json',{body:JSON.stringify({root,count:await page.locator('#count').textContent(),sameDocument:true}),contentType:'application/json'})
  }finally{await server.close();process.chdir(previousCwd)}
})
