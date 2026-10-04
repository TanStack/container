import assert from 'node:assert/strict'
import test from 'node:test'
import {createRequire} from 'node:module'
import {mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {renderedTerminalEdge} from '../scripts/native-terminal-viewport.mjs'
import {nativeTerminalScreen} from '../scripts/native-terminal-screen.mjs'

test('visible terminal preserves queued input and follows typing from scrollback',{
  skip:process.env.NATIVE_TERMINAL_TYPEAHEAD_CONTROL!=='1',
},async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url))
  const fixture=process.env.NATIVE_TERMINAL_TYPEAHEAD_FIXTURE
  const runner=process.env.NATIVE_TERMINAL_TYPEAHEAD_RUNNER
  assert.match(fixture??'',/^\/private\/tmp\/tanstack-native-site-[A-Za-z0-9]+$/)
  assert.ok(runner&&runner.startsWith('/'))
  const dependencies=createRequire(join(fixture,'package.json'))
  const browsers=createRequire(join(runner,'package.json'))
  assert.equal(browsers('playwright/package.json').version,'1.63.0')
  const xtermVersion=dependencies('@xterm/xterm/package.json').version
  const {chromium,firefox,webkit}=browsers('playwright')
  const {createServer}=await import(pathToFileURL(dependencies.resolve('vite')).href)
  const directory=mkdtempSync(join(tmpdir(),'native-terminal-typeahead-'))
  writeFileSync(join(directory,'index.html'),'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/client.tsx"></script></body></html>')
  const source=join(root,'integrations/native-terminal-typeahead/client.tsx')
  writeFileSync(join(directory,'client.tsx'),readFileSync(source))
  const component=join(root,'integrations/tanstack-site/NativeTerminal.client.tsx')
  const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
  const dependencyRoot=dirname(realpathSync(join(runner,'node_modules')))
  const inputPaths=[component,source,join(fixture,'package.json'),join(fixture,'pnpm-lock.yaml'),
    join(dependencyRoot,'package-lock.json'),join(dirname(browsers.resolve('playwright-core/package.json')),'browsers.json'),
    fileURLToPath(import.meta.url),join(root,'scripts/native-terminal-viewport.mjs'),join(root,'scripts/native-terminal-screen.mjs')]
  const inputHashes=Object.fromEntries(inputPaths.map(path=>[path,hash(path)]))
  const receipt={scope:'Controlled UI regression with a gated command callback, not native shell or full-site acceptance.',
    componentSHA256:hash(component),controlSHA256:hash(source),xtermVersion,inputHashes,cases:[],passed:false}
  const server=await createServer({configFile:false,root:directory,envDir:directory,publicDir:false,
    resolve:{alias:[
      {find:'@terminal',replacement:component},
      {find:'./WebContainerTerminal.client',replacement:join(fixture,'src/components/examples/WebContainerTerminal.client.tsx')},
      ...['react-dom','react','@xterm/xterm','@xterm/addon-fit'].map(name=>({find:name,replacement:dirname(dependencies.resolve(name+'/package.json'))})),
    ]},server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[directory,root,fixture]}},
  })
  try{
    await server.listen()
    const address=server.httpServer.address()
    assert.ok(address&&typeof address==='object')
    const origin='http://127.0.0.1:'+address.port
    for(const [name,engine]of Object.entries({chromium,firefox,webkit})){
      const browser=await engine.launch({headless:true})
      try{
        for(const mode of ['stdin','next-command','interrupt','scrollback','background']){
          const page=await browser.newPage({viewport:{width:1000,height:700}})
          const row={browser:name,mode,phase:'opening',passed:false,errors:[]}
          receipt.cases.push(row)
          page.on('pageerror',error=>row.errors.push(String(error)))
          page.on('console',message=>{if(message.type()==='error')row.errors.push(message.text())})
          try{
            await page.goto(origin,{waitUntil:'domcontentloaded'})
            const input=page.getByRole('region',{name:'Sandbox terminal'}).locator('textarea')
            await input.waitFor()
            await input.focus()
            if(mode==='scrollback'||mode==='background'){
              row.phase='history output'
              await page.keyboard.type(mode==='background'?'background':'history');await page.keyboard.press('Enter')
              if(mode==='background')await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('BACKGROUND 30'),undefined,{timeout:5000})
              else await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.trimEnd().endsWith('HISTORY 79project $'),undefined,{timeout:5000})
              row.phase='scroll to history'
              const top=await renderedTerminalEdge(nativeTerminalScreen(page.locator('[data-native-terminal]'),page),-1,{requireMovement:true,maxSteps:32})
              if(mode==='background'){
                row.phase='background preserves scrollback'
                await page.waitForTimeout(300)
                assert.equal(await page.locator('.xterm-rows').textContent(),top.screen)
                await input.focus();await page.keyboard.press('Control+C')
                await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:5000})
                assert.deepEqual(row.errors,[])
                row.passed=true
                continue
              }
              await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('HISTORY 0'),undefined,{timeout:5000})
              row.phase='typing follows prompt'
              await input.focus()
              await page.keyboard.type('echo FOLLOW_INPUT')
              await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.trimEnd().endsWith('project $ echo FOLLOW_INPUT'),undefined,{timeout:5000})
              assert.deepEqual(row.errors,[])
              row.passed=true
              continue
            }
            const command=mode==='next-command'?'hold':'cat'
            await page.keyboard.type(command);await page.keyboard.press('Enter')
            await page.getByRole('status').filter({hasText:'Starting '+command}).waitFor({timeout:5000})
            if(mode==='interrupt')await page.keyboard.press('Control+C')
            await page.keyboard.type(mode==='stdin'?'queued input':'next')
            await page.keyboard.press('Enter')
            await page.getByRole('button',{name:'Release command'}).click()
            if(mode==='stdin'){
              await page.waitForFunction(()=>document.querySelector('[aria-label="Received stdin"]')?.textContent==='queued input\n',undefined,{timeout:5000})
              assert.equal(await page.getByRole('status').innerText(),'Finished cat')
            }else{
              await page.waitForFunction(()=>document.querySelector('[aria-label="Commands"]')?.textContent?.includes('"next"'),undefined,{timeout:5000})
              assert.equal(await page.getByLabel('Commands').innerText(),JSON.stringify([command,'next']))
            }
            assert.deepEqual(row.errors,[])
            row.passed=true
          }catch(error){row.error=String(error);row.screen=await page.locator('body').innerText().catch(()=>null)}
          finally{await page.close()}
        }
      }finally{await browser.close()}
    }
    assert.deepEqual(Object.fromEntries(inputPaths.map(path=>[path,hash(path)])),inputHashes,'Control inputs changed')
    receipt.passed=receipt.cases.length===15&&receipt.cases.every(row=>row.passed)
  }finally{
    await server.close()
    writeFileSync(join(directory,'results.json'),JSON.stringify(receipt,null,2)+'\n')
    console.log('NATIVE_TERMINAL_TYPEAHEAD_RECEIPT '+join(directory,'results.json'))
  }
  assert.equal(receipt.passed,true,JSON.stringify(receipt.cases))
})
