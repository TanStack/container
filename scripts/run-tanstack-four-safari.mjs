#!/usr/bin/env node
import {mkdirSync,writeFileSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {activateSafariAutomation,assertSafariAutomationAvailable,startSafariDriver,stopSafariAutomationProcess,stopSafariDriver} from './safari-webdriver.mjs'

const args=process.argv.slice(2)
const option=name=>{const index=args.indexOf(name);return index===-1?undefined:args[index+1]}
const required=name=>{const value=option(name);if(!value)throw Error(`Missing ${name}`);return value}
const example=required('--example'),ownerUrl=required('--owner-url'),output=resolve(required('--out'))
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const startedAt=new Date().toISOString(),started=performance.now(),assertions=[]
const elapsedMs=()=>Math.round((performance.now()-started)*1000)/1000
const waitFor=async(driver,probe,description,timeoutMs=180_000)=>{
  const deadline=Date.now()+timeoutMs;let last
  while(Date.now()<deadline){try{const value=await probe();if(value)return value}catch(error){last=error}await delay(200)}
  throw Error(`Timed out waiting for ${description}${last?`: ${last.message}`:''}`)
}
const executeTruthy=(driver,script,args=[])=>driver.execute(`return Boolean(${script})`,args)
const elementByText=(driver,selector,text)=>driver.execute(
  `return [...document.querySelectorAll(arguments[0])].find(element=>element.textContent?.replace(/\\s+/g,' ').trim()===arguments[1])??null`,
  [selector,text],
)
const record=(id,detail={})=>assertions.push({id,result:'passed',elapsedMs:elapsedMs(),...detail})
let child,driver,capabilities,failure,safariPID
let diagnostics
try{
  assertSafariAutomationAvailable()
  const startedDriver=await startSafariDriver({binary:option('--driver')??'/usr/bin/safaridriver'})
  child=startedDriver.child;driver=startedDriver.driver;driver.requestTimeoutMs=180_000;capabilities=await driver.createSession()
  await driver.maximizeWindow();safariPID=(await activateSafariAutomation()).pid
  await driver.navigate(ownerUrl)
  if(await driver.execute('return document.visibilityState')!=='visible')throw Error('Safari acceptance owner is not visible. Unlock the Mac and keep the Safari automation window visible.')
  const run=await waitFor(driver,()=>driver.execute(`
    return [...document.querySelectorAll('button')].find(element=>element.textContent?.replace(/\\s+/g,' ').trim()==='Run'&&!element.disabled)??null
  `),'enabled Run button',60_000)
  await driver.execute('arguments[0].click()',[run])
  const frame=await waitFor(driver,()=>driver.find('iframe[title="Workspace preview"]'),'workspace preview iframe',240_000)
  await driver.frame(frame)
  const recoverPreview=async()=>{
    await driver.parentFrame().catch(()=>{})
    await driver.frame(await driver.find('iframe[title="Workspace preview"]'))
  }
  const previewProbe=async probe=>{try{return await probe()}catch{await recoverPreview();return false}}
  const bodyIncludes=text=>previewProbe(()=>executeTruthy(driver,'document.body.innerText.includes(arguments[0])',[text]))
  const hydrated=()=>previewProbe(()=>executeTruthy(driver,`((globalThis.__safariParityBootstrap??=(globalThis.$_TSR?.h?globalThis.$_TSR:null))?.hydrated===true&&globalThis.__safariParityBootstrap?.streamEnded===true)`))
  if(example==='start-counter'){
    await waitFor(driver,()=>bodyIncludes('Add 1 to 0?'),'counter SSR')
    record('ssr',{text:'Add 1 to 0?'})
    await waitFor(driver,hydrated,'counter hydration',120_000);record('hydration')
    await driver.pointerClick(await elementByText(driver,'button','Add 1 to 0?'))
    await waitFor(driver,()=>bodyIncludes('Add 1 to 1?'),'counter server function',60_000)
    record('server-function')
  }else if(example==='start-basic'){
    await waitFor(driver,()=>bodyIncludes('Welcome Home!!!'),'Start Basic SSR')
    record('ssr',{text:'Welcome Home!!!'})
    await waitFor(driver,hydrated,'Start Basic hydration',120_000);record('hydration')
    const asset=await driver.execute(`
      const image=new Image();image.src='/favicon-32x32.png';
      return image.src.endsWith('/favicon-32x32.png')
    `)
    if(!asset)throw Error('Binary asset URL was not preserved')
    record('binary-asset')
    await driver.pointerClick(await elementByText(driver,'a','Deferred'))
    for(const text of ['John Doe','Tanner Linsley','Hello deferred!'])await waitFor(driver,()=>bodyIncludes(text),`deferred text ${text}`,60_000)
    record('server-function')
  }else if(example==='start-streaming-data-from-server-functions'){
    await waitFor(driver,()=>bodyIncludes('Typed Readable Stream'),'streaming SSR')
    record('ssr',{text:'Typed Readable Stream'})
    await waitFor(driver,hydrated,'streaming hydration',120_000);record('hydration')
    for(const [id,label,index] of [['readable-stream','Get 10 random numbers (ReadableStream)',0],['async-generator','Get 10 random numbers (Async Generator Function)',1]]){
      await driver.pointerClick(await elementByText(driver,'button',label))
      await waitFor(driver,()=>executeTruthy(driver,`(document.querySelectorAll('pre')[arguments[0]]?.textContent.match(/Number #\\d+:/g)??[]).length===10`,[index]),`${id} chunks`,60_000)
      record(id,{chunks:10})
    }
  }else if(example==='basic-ssr-file-based'){
    await waitFor(driver,()=>bodyIncludes('Welcome Home!'),'Router SSR')
    record('ssr',{text:'Welcome Home!'})
    await waitFor(driver,async()=>await previewProbe(()=>executeTruthy(driver,'Boolean(globalThis.__TSR_ROUTER__)'))&&await hydrated(),'Router hydration',120_000)
    const timeOrigin=await driver.execute('return performance.timeOrigin')
    await driver.pointerClick(await elementByText(driver,'a','Posts'))
    await waitFor(driver,()=>bodyIncludes('Select a post.'),'Router client navigation',60_000)
    if(await driver.execute('return performance.timeOrigin')!==timeOrigin)throw Error('Router link caused a document navigation')
    record('hydration',{documentNavigation:false})
  }else throw Error(`Unknown example: ${example}`)
}catch(error){
  failure=String(error)+'\n'+String(error?.stack??'')
  await driver?.parentFrame().catch(()=>{})
  diagnostics=await driver?.execute(`return {body:document.body.innerText.slice(-12000),crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer,router:Boolean(globalThis.__TSR_ROUTER__),resources:performance.getEntriesByType('resource').map(entry=>entry.name).slice(-128),iframes:[...document.querySelectorAll('iframe')].map(frame=>({title:frame.title,src:frame.src})),buttons:[...document.querySelectorAll('button')].map(button=>({text:button.textContent?.trim(),disabled:button.disabled}))}`).catch(diagnosticError=>({error:String(diagnosticError)}))
}
finally{await driver?.close();await stopSafariDriver(child);if(safariPID)await stopSafariAutomationProcess(safariPID)}
const report={schemaVersion:1,runtime:'sdk',exampleId:example,result:failure?'failed':'passed',startedAt,finishedAt:new Date().toISOString(),browser:{name:'Safari',version:capabilities?.browserVersion??capabilities?.version??null},assertions,...(failure?{error:failure,diagnostics}:{})}
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n')
console.log(`${report.result.toUpperCase()} sdk ${example} Safari: ${output}`)
if(failure)process.exitCode=1
