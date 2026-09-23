import {test,expect} from '@playwright/test'
import {mkdtempSync,cpSync,readFileSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'

let host,evidence
test.beforeAll(async()=>{
  const sdk=resolve(process.env.SDK_OUTPUT)
  const directory=mkdtempSync(join(tmpdir(),'sdk-basic-consumer-'))
  cpSync(join(sdk,'examples/basic'),join(directory,'example'),{recursive:true})
  const env={...process.env,npm_config_cache:join(directory,'npm-cache'),npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'}
  const packed=JSON.parse(execFileSync('npm',['pack',sdk,'--json','--ignore-scripts','--pack-destination',directory],{encoding:'utf8',env,timeout:30000}))
  expect(packed).toHaveLength(1)
  const tarball=join(directory,packed[0].filename)
  execFileSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',tarball],{cwd:join(directory,'example'),env,timeout:30000})
  const {startExample}=await import(pathToFileURL(join(directory,'example/server.mjs')).href)
  host=await startExample({ownerPort:0,previewPort:0})
  evidence={sdk,directory,tarballSHA256:createHash('sha256').update(readFileSync(tarball)).digest('hex'),manifestSHA256:createHash('sha256').update(readFileSync(join(sdk,'manifest.json'))).digest('hex')}
})
test.afterAll(async()=>{await host?.close()})

test('external SDK example edits, runs, previews and restores files after host reload',async({page},info)=>{
  test.setTimeout(60000)
  const errors=[];page.on('pageerror',error=>errors.push(String(error)))
  await page.goto(host.ownerOrigin)
  await expect(page.locator('#output')).toHaveText('Ready')
  await page.locator('#source').fill('Saved hello from the public SDK')
  await page.getByRole('button',{name:'Run and preview'}).click()
  await expect(page.locator('#output')).toContainText('Exit 0\nSaved hello from the public SDK')
  await expect(page.frameLocator('#preview iframe').locator('#message')).toHaveText('Saved hello from the public SDK')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  await expect(page.locator('#output')).toContainText('Files saved.')
  await page.getByRole('button',{name:'Reload host page'}).click()
  await expect(page.locator('#output')).toHaveText('Ready')
  await expect(page.locator('#source')).toHaveValue('Hello from the browser workspace')
  await page.getByRole('button',{name:'Resume saved files'}).click()
  await expect(page.locator('#source')).toHaveValue('Saved hello from the public SDK')
  await page.getByRole('button',{name:'Run and preview'}).click()
  await expect(page.frameLocator('#preview iframe').locator('#message')).toHaveText('Saved hello from the public SDK')
  await expect(page.locator('#output')).toContainText('Exit 0')
  expect(errors).toEqual([])
  await page.screenshot({path:info.outputPath('basic-example.png'),fullPage:true})
  const path=info.outputPath('basic-example.json')
  await writeFile(path,JSON.stringify({...evidence,errors,browser:info.project.name,browserVersion:page.context().browser()?.version(),actualSafari:false},null,2))
  await info.attach('basic-example.json',{path,contentType:'application/json'})
})

test('packaged file sessions preserve sequential cursors during positioned I/O',async({page})=>{
  await page.goto(host.ownerOrigin)
  const result=await page.evaluate(async()=>{
    const {WorkerKernel}=await import('/sdk/index.js')
    const kernel=new WorkerKernel({'/input':'abcdef'},{assetBaseURL:new URL('/runtime/',location.href).href})
    const lease=await kernel.openFileSession({writable:true})
    const text=value=>new TextDecoder().decode(value)
    try{
      const fd=await lease.call('open',['/input','r+'])
      const first=text(await lease.call('read',[fd,2]))
      const positioned=text(await lease.call('read',[fd,2,4]))
      const next=text(await lease.call('read',[fd,1]))
      await lease.call('write',[fd,new TextEncoder().encode('XY'),0])
      const after=text(await lease.call('read',[fd,1]))
      return {first,positioned,next,after,contents:await kernel.readText('/input')}
    }finally{await lease.close();kernel.close()}
  })
  expect(result).toEqual({first:'ab',positioned:'ef',next:'c',after:'d',contents:'XYcdef'})
})
