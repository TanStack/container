import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve,sep} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {chromium} from '@playwright/test'

const capture=process.env.NATIVE_OWNER_CONTROL_CAPTURE
const fresh=process.env.NATIVE_OWNER_CONTROL_FRESH_NPM==='1'
if(!capture)throw Error('Set NATIVE_OWNER_CONTROL_CAPTURE to an owner dependency capture directory')
const source=JSON.parse(await readFile(join(capture,'source.json'),'utf8'))
const lock=await readFile(join(capture,'package-lock.json'))
const directory=await mkdtemp(join(tmpdir(),'native-owner-node-stream-'))
for(const [path,contents] of Object.entries(source.files)){
  if(fresh&&path==='/project/package-lock.json')continue
  if(!path.startsWith('/project/'))throw Error(`Unexpected capture path: ${path}`)
  const target=resolve(directory,path.slice('/project/'.length))
  if(!target.startsWith(directory+sep))throw Error(`Capture path leaves control directory: ${path}`)
  await mkdir(dirname(target),{recursive:true})
  const text=typeof contents==='string'?contents:new TextDecoder().decode(Uint8Array.from(Object.values(contents)))
  await writeFile(target,text)
}
if(!fresh)await writeFile(join(directory,'package-lock.json'),lock)
console.log(JSON.stringify({directory,capture,lockSHA256:createHash('sha256').update(lock).digest('hex')}))
let nativeLockAdditions=[]
if(!fresh&&process.env.NATIVE_OWNER_CONTROL_ADD_PLATFORM_PACKAGES==='1'){
  const supplement=spawnSync('npm',['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],{
    cwd:directory,stdio:'inherit',timeout:180_000,
  })
  if(supplement.error)throw supplement.error
  if(supplement.status!==0)throw Error(`Native lock supplementation failed: ${supplement.status}`)
  const before=JSON.parse(lock),after=JSON.parse(await readFile(join(directory,'package-lock.json'),'utf8'))
  for(const [path,entry] of Object.entries(before.packages)){
    const installed=after.packages[path]
    if(!installed||installed.version!==entry.version||installed.integrity!==entry.integrity)
      throw Error(`Native control changed a captured dependency: ${path}`)
  }
  nativeLockAdditions=Object.keys(after.packages).filter(path=>!Object.hasOwn(before.packages,path))
  for(const path of nativeLockAdditions){
    if(after.packages[path].optional!==true)throw Error(`Native control added a non-optional dependency: ${path}`)
  }
  console.log(JSON.stringify({nativeLockAdditions}))
}
const install=spawnSync('npm',[fresh?'install':'ci','--ignore-scripts','--no-audit','--no-fund'],{
  cwd:directory,stdio:'inherit',timeout:180_000,
})
if(install.error)throw install.error
if(install.status!==0)throw Error(`Exact-lock Node install failed: ${install.status}`)
let dedupeChanges=[]
if(process.env.NATIVE_OWNER_CONTROL_DEDUPE==='1'){
  const before=JSON.parse(await readFile(join(directory,'package-lock.json'),'utf8'))
  const dedupe=spawnSync('npm',['dedupe','--ignore-scripts','--no-audit','--no-fund'],{
    cwd:directory,stdio:'inherit',timeout:180_000,
  })
  if(dedupe.error)throw dedupe.error
  if(dedupe.status!==0)throw Error(`Native dedupe control failed: ${dedupe.status}`)
  const after=JSON.parse(await readFile(join(directory,'package-lock.json'),'utf8'))
  const identity=entry=>JSON.stringify([entry.version,entry.integrity,entry.resolved])
  const originalIdentities=new Set(Object.values(before.packages).map(identity))
  for(const [path,entry] of Object.entries(after.packages)){
    if(!originalIdentities.has(identity(entry)))throw Error(`Dedupe introduced an uncaptured package: ${path}`)
  }
  dedupeChanges=[...new Set([...Object.keys(before.packages),...Object.keys(after.packages)])]
    .filter(path=>identity(before.packages[path]??{})!==identity(after.packages[path]??{}))
  console.log(JSON.stringify({dedupeChanges}))
}
const child=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','0'],{
  cwd:directory,stdio:['ignore','pipe','pipe'],
})
let output='',browser
child.stdout.on('data',chunk=>{output+=chunk;process.stdout.write(chunk)})
child.stderr.on('data',chunk=>{output+=chunk;process.stderr.write(chunk)})
const diagnostics=[],requests=[],rows=[]
try{
  let url
  for(let attempt=0;attempt<600;attempt++){
    url=output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]
    if(url)break
    if(child.exitCode!==null)throw Error(`Node Vite exited: ${child.exitCode}`)
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  if(!url)throw Error('Node Vite did not announce a local URL')
  browser=await chromium.launch({headless:true})
  const page=await browser.newPage()
  page.on('pageerror',error=>diagnostics.push(String(error)))
  page.on('response',response=>{
    if(response.url().includes('/_serverFn/'))requests.push({url:response.url(),status:response.status()})
  })
  for(const label of ['Get 10 random numbers (ReadableStream)','Get 10 random numbers (Async Generator Function)']){
    await page.goto(url)
    const button=page.getByRole('button',{name:label,exact:true})
    await button.waitFor()
    await page.waitForTimeout(1000)
    await button.click()
    const started=Date.now()
    let firstMs,lastMs,text=''
    for(let attempt=0;attempt<150;attempt++){
      text=await page.locator('body').innerText()
      if(text.includes('Number #1:')&&firstMs===undefined)firstMs=Date.now()-started
      if(text.includes('Number #10:')){lastMs=Date.now()-started;break}
      await page.waitForTimeout(100)
    }
    rows.push({label,firstMs,lastMs,progressive:firstMs!==undefined&&lastMs!==undefined&&lastMs-firstMs>1000,text})
  }
  const installedLock=await readFile(join(directory,'package-lock.json'))
  const result={capture,directory,node:process.version,freshNpmResolution:fresh,
    lockSHA256:createHash('sha256').update(lock).digest('hex'),
    installedLockSHA256:createHash('sha256').update(installedLock).digest('hex'),
    nativeLockAdditions,dedupeChanges,rows,requests,diagnostics}
  await writeFile(join(directory,'control-result.json'),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
  if(rows.some(row=>!row.progressive))process.exitCode=1
}finally{
  await browser?.close()
  child.kill('SIGTERM')
}
