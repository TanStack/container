import {chromium,firefox,webkit} from 'playwright'
import {writeFile} from 'node:fs/promises'
import {unexpectedPreviewErrors} from './native-preview-navigation-errors.mjs'
import {diagnosticWithin} from './native-browser-diagnostic.mjs'
import {nativeTerminalViewport,renderedTerminalEdge,renderedTerminalScan} from './native-terminal-viewport.mjs'
import {nativeTerminalScreen} from './native-terminal-screen.mjs'

const url=(process.env.NATIVE_SITE_ORIGIN??'http://127.0.0.1:4198')+'/start/latest/docs/framework/react/examples/start-counter?panel=playground'
const previewOrigin=process.env.NATIVE_PREVIEW_ORIGIN??'http://127.0.0.1:4199'
const engines={chromium,firefox,webkit}
if(process.env.NATIVE_BROWSER&&!Object.hasOwn(engines,process.env.NATIVE_BROWSER))
  throw Error('NATIVE_BROWSER must be chromium, firefox or webkit')
if(process.env.NATIVE_HEADLESS!==undefined&&!['0','1'].includes(process.env.NATIVE_HEADLESS))
  throw Error('NATIVE_HEADLESS must be 0 or 1')
const headless=process.env.NATIVE_HEADLESS!=='0'
const failureHoldText=process.env.NATIVE_FAILURE_HOLD_MS??'0'
const failureHoldMs=Number(failureHoldText)
if(!/^(0|[1-9]\d*)$/.test(failureHoldText)||!Number.isSafeInteger(failureHoldMs)||failureHoldMs>120000)
  throw Error('NATIVE_FAILURE_HOLD_MS must be an integer from 0 to 120000')
if(failureHoldMs>0&&headless)
  throw Error('NATIVE_FAILURE_HOLD_MS requires NATIVE_HEADLESS=0')
const repetitions=Number(process.env.NATIVE_TERMINAL_REPETITIONS??1)
if(!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>10)
  throw Error('NATIVE_TERMINAL_REPETITIONS must be an integer from 1 to 10')
for(let repetition=1;repetition<=repetitions;repetition++)for(const [name,engine] of Object.entries(engines)){
  if(process.env.NATIVE_BROWSER&&process.env.NATIVE_BROWSER!==name)continue
  const browser=await engine.launch({headless})
  let page
  const pageErrors=[]
  const failedModules=[]
  const previewEvents=[]
  const documentTraces=[]
  const failedPreviewRequests=[]
  const started=Date.now()
  let phase='startup'
  let commandNumber=0
  const progressTimer=process.env.NATIVE_TRACE_PROGRESS==='1'
    ?setInterval(()=>console.log(`${name} run ${repetition}/${repetitions}: ${phase}, ${Math.round((Date.now()-started)/1000)}s`),10000):undefined
  progressTimer?.unref()
  const record=event=>{
    previewEvents.push({elapsed:Date.now()-started,phase,...event})
    if(previewEvents.length>500)previewEvents.shift()
  }
  try{
    page=await browser.newPage({viewport:{
      width:Number(process.env.NATIVE_VIEWPORT_WIDTH??1440),
      height:Number(process.env.NATIVE_VIEWPORT_HEIGHT??900),
    }})
    const moduleEvents=[]
    const consoleErrors=[]
    if(process.env.NATIVE_TRACE_OWNER_PORTS==='1'){
      await page.addInitScript(()=>{
        const post=MessagePort.prototype.postMessage
        MessagePort.prototype.postMessage=function(data,...rest){
          if(data?.protocol==='native-owner-v1'){
            console.debug('[terminal-owner-port] '+JSON.stringify({origin:location.origin,type:data.type,id:data.id,operation:data.operation,ok:data.ok,path:data.path,error:data.error,cwd:data.value?.cwd,changedPaths:data.value?.changedPaths}))
          }
          return Reflect.apply(post,this,[data,...rest])
        }
      })
    }
    await page.addInitScript(({previewOrigin})=>{
      if(location.origin!==previewOrigin)return
      const id=`${performance.timeOrigin}-${Math.random().toString(36).slice(2)}`
      const trace=(event,extra={})=>console.log('[terminal-document] '+JSON.stringify({id,event,...extra}))
      trace('start',{url:location.href})
      addEventListener('DOMContentLoaded',()=>trace('domcontentloaded'))
      addEventListener('load',()=>trace('load'))
      addEventListener('pagehide',()=>trace('pagehide'))
      addEventListener('error',event=>trace('error',{message:event.message}))
    },{previewOrigin})
    page.on('pageerror',error=>{pageErrors.push(`${phase}: ${error.name}: ${error.message}\n${error.stack??''}`);record({type:'pageerror',name:error.name,message:error.message})})
    page.on('console',message=>{
      if(message.type()==='error')consoleErrors.push(message.text())
      if(message.text().startsWith('[terminal-render] ')){
        try{record({type:'terminal-render',...JSON.parse(message.text().slice('[terminal-render] '.length))})}
        catch{record({type:'malformed-terminal-render'})}
      }
      if(message.text().startsWith('[terminal-owner-port] ')){
        try{
          const {type:ownerType,...fields}=JSON.parse(message.text().slice('[terminal-owner-port] '.length))
          record({type:'owner-port',ownerType,...fields})
        }
        catch{record({type:'malformed-owner-trace'})}
      }
      if(message.text().startsWith('[terminal-document] ')){
        try{
          const trace=JSON.parse(message.text().slice('[terminal-document] '.length))
          record({type:'document',...trace})
          documentTraces.push(`${phase}: [native-document] ${trace.event} ${trace.id}${trace.message?' '+trace.message:''}`)
        }
        catch{record({type:'malformed-document-trace',message:message.text()})}
      }
    })
    page.on('framenavigated',frame=>record({type:'navigation',url:frame.url()}))
    page.on('request',request=>{
      if(request.url().includes('/node_modules/@tanstack/react-start/dist/plugin/default-entry/client.tsx'))
        moduleEvents.push({kind:'request',url:request.url()})
    })
    page.on('response',response=>{
      if(response.url().includes('/node_modules/@tanstack/react-start/dist/plugin/default-entry/client.tsx'))
        moduleEvents.push({kind:'response',status:response.status(),url:response.url()})
      if(response.url().includes('/node_modules/@tanstack/react-start/dist/plugin/default-entry/client.tsx')&&response.status()>=400)
        void response.text().then(body=>failedModules.push({status:response.status(),url:response.url(),body:body.slice(0,1500)})).catch(error=>failedModules.push({error:String(error)}))
    })
    page.on('requestfailed',request=>{
      if(request.url().startsWith(previewOrigin+'/')){
        record({type:'requestfailed',url:request.url(),failure:request.failure()})
        failedPreviewRequests.push(`${phase}: ${JSON.stringify(request.failure())} ${request.url()}`)
      }
      if(request.url().includes('/node_modules/@tanstack/react-start/dist/plugin/default-entry/client.tsx'))
        failedModules.push({url:request.url(),failure:request.failure()?.errorText})
    })
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000})
    await page.locator('[data-native-preview-ready="true"]').waitFor({timeout:180000})
    await page.getByRole('button',{name:'Show terminal'}).click()
    await page.getByRole('button',{name:'Terminal',exact:true}).click()
    const terminal=page.getByRole('region',{name:'Sandbox terminal'})
    const input=terminal.locator('textarea[aria-label="Sandbox terminal"]')
    const expectTerminalFocus=async(stage)=>{
      try{await page.waitForFunction(()=>document.activeElement?.matches('[data-native-terminal] textarea[aria-label="Sandbox terminal"]'),undefined,{timeout:5000})}
      catch(error){throw Error(`${name} terminal did not receive focus after ${stage}: ${await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,300))}`,{cause:error})}
    }
    if(process.env.NATIVE_FOCUS_BEHAVIOR==='1')await expectTerminalFocus('opening')
    if(process.env.NATIVE_COMPACT_LAYOUT==='1'){
      const showFiles=page.getByRole('button',{name:'Show files'})
      await showFiles.waitFor({timeout:5000})
      const activeTab=page.locator('button[aria-current="page"][title="/src/routes/index.tsx"]')
      await activeTab.waitFor({state:'visible',timeout:5000})
      const tabVisible=await activeTab.evaluate(element=>{
        const tab=element.getBoundingClientRect(),strip=element.parentElement.getBoundingClientRect()
        return tab.left>=strip.left-1&&tab.right<=strip.right+1
      })
      if(!tabVisible)throw Error(`${name} active file tab is outside the compact editor viewport`)
      await showFiles.click()
      await page.getByRole('button',{name:'Hide files'}).click()
      await showFiles.waitFor({state:'visible',timeout:5000})
    }
    await input.focus()
    const paste=async(text)=>input.evaluate((element,value)=>{
      const clipboardData=new DataTransfer()
      clipboardData.setData('text/plain',value)
      const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData})
      if(!event.clipboardData?.getData('text/plain'))Object.defineProperty(event,'clipboardData',{value:{getData:(format)=>format==='text/plain'?value:''}})
      element.dispatchEvent(event)
    },text)
    const command=async(line,expected,prompt)=>{
      phase='terminal command '+(++commandNumber)
      record({type:'command',line})
      await input.focus()
      const before=await terminal.locator('.xterm-rows').textContent()
      await page.keyboard.type(line)
      await page.keyboard.press('Enter')
      try{await page.waitForFunction(({expected,prompt,before})=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text!==before&&text.trimEnd().endsWith(prompt)
      },{expected,prompt,before},{timeout:line==='pnpm run build'||line==='pnpm install'?180000:30000})}
      catch(error){throw Error(`${name} did not render ${JSON.stringify(expected)} after ${line}: ${await terminal.locator('.xterm-rows').textContent()}`,{cause:error})}
      const rendered=await terminal.locator('.xterm-rows').textContent()
      if(!(typeof expected==='string'?rendered?.includes(expected):expected.test(rendered??''))){
        if(await terminal.locator('.xterm-scrollable-element').count()){
          const result=await renderedTerminalScan(nativeTerminalViewport(terminal,page),text=>typeof expected==='string'?text?.includes(expected):expected.test(text??''))
          if(!result.found)throw Error(`${name} command failed after ${line}: ${result.screens.join('\n[scroll]\n')}`)
          return
        }
        const viewport=terminal.locator('.xterm-viewport')
        const height=await viewport.evaluate(element=>element.scrollHeight)
        const screens=[]
        for(let offset=0;offset<=height;offset+=24){
          await viewport.evaluate((element,top)=>{element.scrollTop=top},offset)
          await page.waitForTimeout(30)
          screens.push(await terminal.locator('.xterm-rows').textContent())
        }
        if(!screens.some(text=>typeof expected==='string'?text?.includes(expected):expected.test(text??'')))
          throw Error(`${name} command failed after ${line}: ${[...new Set(screens)].join('\n[scroll]\n')}`)
      }
    }
    const scrollbackContains=async(expected)=>{
      if(await terminal.locator('.xterm-scrollable-element').count())
        return renderedTerminalScan(nativeTerminalViewport(terminal,page),text=>text?.includes(expected))
      const viewport=terminal.locator('.xterm-viewport')
      const height=await viewport.evaluate(element=>element.scrollHeight)
      const screens=[]
      for(let offset=0;offset<=height;offset+=24){
        await viewport.evaluate((element,top)=>{element.scrollTop=top},offset)
        await page.waitForTimeout(100)
        const content=await terminal.locator('.xterm-rows').textContent()
        screens.push(content)
        if(content?.includes(expected))return {found:true,height,screens}
      }
      return {found:false,height,screens}
    }
    await command('pwd','/project','project $')
    if(process.env.NATIVE_TOGGLE_TERMINAL==='1'){
      await command('TERMINAL_REOPENED=still-here','project $','project $')
      await page.getByRole('button',{name:'Hide terminal'}).click()
      if(await terminal.isVisible())throw Error(`${name} terminal stayed visible after hiding it`)
      await page.getByRole('button',{name:'Show terminal'}).click()
      await terminal.waitFor({state:'visible',timeout:10000})
      if(process.env.NATIVE_FOCUS_BEHAVIOR==='1')await expectTerminalFocus('reopening')
      await command('printf "%s\\n" "$TERMINAL_REOPENED"','still-here','project $')
      await command('pwd','/project','project $')
    }
    if(process.env.NATIVE_UNSUPPORTED==='1'){
      await command('definitely-not-installed-command','definitely-not-installed-command: command not found','project $')
      const failure=await scrollbackContains('Exited with code 127')
      if(!failure.found)throw Error(`${name} unsupported command did not report exit 127`)
      await command('pwd','/project','project $')
    }
    if(process.env.NATIVE_START_CHANGED_INSTALL==='1'||process.env.NATIVE_INSTALL_INTERRUPT==='1'){
      await command(`node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync("package.json"));const l=JSON.parse(fs.readFileSync("package-lock.json"));const v=l.packages["node_modules/picocolors"].version;m.dependencies={...m.dependencies,picocolors:v};l.packages[""].dependencies={...l.packages[""].dependencies,picocolors:v};fs.writeFileSync("package.json",JSON.stringify(m));fs.writeFileSync("package-lock.json",JSON.stringify(l))'`,
        'project $','project $')
      if(process.env.NATIVE_START_CHANGED_INSTALL==='1')await command('pnpm install','Dependencies ready','project $')
    }
    if(process.env.NATIVE_SHELL_STATE==='1'){
      await command('LOCAL=hello; export EXPORTED=world','project $','project $')
      await command('printf "%s:%s\\n" "$LOCAL" "$EXPORTED"','hello:world','project $')
      await command('node -e "console.log(process.env.EXPORTED)"','world','project $')
      await command('unset LOCAL EXPORTED','project $','project $')
      await command('printf "%s:%s\\n" "$LOCAL" "$EXPORTED"',':','project $')
      await command('greet() { printf "hello %s\\n" "$1"; }','project $','project $')
      await command('greet terminal','hello terminal','project $')
      await command('unset -f greet','project $','project $')
    }
    if(process.env.NATIVE_TAB_SWITCH==='1'){
      await input.focus()
      await page.keyboard.type('sleep 2')
      await page.keyboard.press('Enter')
      await page.getByRole('button',{name:'Process',exact:true}).click()
      if(await terminal.isVisible())throw Error(`${name} terminal stayed visible on Process tab`)
      await page.getByRole('button',{name:'Terminal',exact:true}).click()
      if(process.env.NATIVE_FOCUS_BEHAVIOR==='1')await expectTerminalFocus('returning from Process')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:10000})
      await command('pwd','/project','project $')
    }
    if(process.env.NATIVE_HIDE_PREVIEW==='1'){
      await page.getByRole('button',{name:'Hide preview'}).click()
      if(!await terminal.isVisible())throw Error(`${name} terminal disappeared when preview was hidden`)
      if(await page.getByRole('separator',{name:'Resize preview and terminal panels'}).isVisible())
        throw Error(`${name} preview separator remained visible without preview`)
      await command('pwd','/project','project $')
      if(process.env.NATIVE_PREVIEW_HIDDEN_CAPTURE)
        await page.screenshot({path:process.env.NATIVE_PREVIEW_HIDDEN_CAPTURE.replace('{browser}',name)})
      await page.getByRole('button',{name:'Show preview'}).click()
      await page.locator('iframe[title="Workspace preview"]').waitFor({state:'visible',timeout:30000})
    }
    if(process.env.NATIVE_TREE_COMMANDS==='1'){
      await command('mkdir -p terminal-tree/nested','project $','project $')
      await command('cp package.json terminal-tree/nested/package.json','project $','project $')
      await command('cp -r terminal-tree terminal-tree-copy','project $','project $')
      await command('cat terminal-tree-copy/nested/package.json','"name"','project $')
      await command('mv terminal-tree-copy terminal-tree-moved','project $','project $')
      await command('rm -r terminal-tree-moved','project $','project $')
      await command('node -e "console.log(require(\'node:fs\').existsSync(\'terminal-tree-moved\'))"','false','project $')
    }
    if(process.env.NATIVE_INSTALL==='1'){
      await command('pnpm install','Dependencies ready','project $')
      await page.locator('[data-native-preview-ready="true"]').waitFor({timeout:180000})
      await command('node -e "console.log(40+2)"','42','project $')
    }
    if(process.env.NATIVE_INSTALL_INTERRUPT==='1'){
      await page.keyboard.type('pnpm install')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.includes('Installing dependencies...'),undefined,{timeout:30000})
      await page.keyboard.press('Control+C')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.trimEnd().endsWith('project $')
      },undefined,{timeout:30000})
      await page.locator('[data-native-preview-ready="true"]').waitFor({timeout:30000})
      await command('node -e "console.log(40+2)"','42','project $')
    }
    if(process.env.NATIVE_INSTALL_FAILURE==='1'){
      await command('cp package.json package.json.before-install','project $','project $')
      await command("node -e 'require(\"node:fs\").writeFileSync(\"package.json\",\"{bad json\")'",'project $','project $')
      await command('cat package.json','{bad json','project $')
      await command('pnpm install','Exited with code 1','project $')
      await command('mv package.json.before-install package.json','project $','project $')
      await page.locator('[data-native-preview-ready="true"]').waitFor({timeout:30000})
      await command('node -e "console.log(40+2)"','42','project $')
    }
    if(process.env.NATIVE_COMPLETE==='1'){
      await page.keyboard.type('pn')
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $ pnpm'),undefined,{timeout:5000})
      await page.keyboard.press('Control+C')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:5000})
      await command('touch completions-unique.txt','completions-unique.txt','project $')
      await page.keyboard.type('cat completions-u')
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('cat completions-unique.txt'),undefined,{timeout:5000})
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
      await command('touch completion-alpha-one.txt completion-alpha-two.txt','completion-alpha-two.txt','project $')
      await page.keyboard.type('ls completion-al')
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('ls completion-alpha-'),undefined,{timeout:5000})
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.split('completion-alpha-one.txt').length>=3&&text.split('completion-alpha-two.txt').length>=3&&text.trimEnd().endsWith('ls completion-alpha-')
      },undefined,{timeout:5000})
      if(process.env.NATIVE_SCREENSHOT==='1')await page.screenshot({path:'/private/tmp/terminal-completion.png'})
      await page.keyboard.press('Control+C')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:5000})
      await command('touch "space name.txt"','space name.txt','project $')
      await page.keyboard.type('cat space')
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('cat space\\ name.txt'),undefined,{timeout:5000})
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
      await page.keyboard.type('cat "space na')
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('cat "space name.txt"'),undefined,{timeout:5000})
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
      await page.keyboard.type("cat 'space na")
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith("cat 'space name.txt'"),undefined,{timeout:5000})
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
      await command('mkdir completion-dir','completion-dir','project $')
      await page.keyboard.type('cd completion-d')
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('cd completion-dir/'),undefined,{timeout:5000})
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('completion-dir $'),undefined,{timeout:30000})
      await command('cd ..','project $','project $')
    }
    if(process.env.NATIVE_PASTE==='1'){
      await input.focus()
      await paste('echo pasted')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('echo pastedpasted')&&text.trimEnd().endsWith('project $')
      },undefined,{timeout:5000}).catch(async error=>{throw Error(`${name} single paste state: ${await terminal.locator('.xterm-rows').textContent()}`,{cause:error})})
      await input.focus()
      await paste('echo first\necho second')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('echo firstfirst')&&text.trimEnd().endsWith('project $ echo second')
      },undefined,{timeout:5000}).catch(async error=>{throw Error(`${name} multiline paste state: ${await terminal.locator('.xterm-rows').textContent()}`,{cause:error})})
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('echo secondsecond')&&text.trimEnd().endsWith('project $')
      },undefined,{timeout:30000})
      const multi=await terminal.locator('.xterm-rows').textContent()??''
      if(!multi.includes('echo firstfirst')||!multi.includes('echo secondsecond'))throw Error(`${name} multiline paste was lost: ${multi}`)
      await paste('echo alpha\necho beta\n')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('echo alphaalpha')&&text.includes('echo betabeta')&&text.trimEnd().endsWith('project $')
      },undefined,{timeout:30000})
    }
    if(process.env.NATIVE_LONG_EDIT==='1'){
      await input.focus()
      await page.keyboard.type('echo '+'x'.repeat(100))
      await page.keyboard.press('Home')
      await page.keyboard.press('End')
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.type('Y')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.includes('Yx'),undefined,{timeout:5000})
      const edited=await terminal.locator('.xterm-rows').textContent()??''
      if(edited.split('project $ echo x').length!==2||!edited.includes('Yx'))
        throw Error(`${name} wrapped command line was not redrawn cleanly: ${edited}`)
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
    }
    if(process.env.NATIVE_CLEAR_EDIT==='1'){
      await input.focus()
      await page.keyboard.type('echo before-clear')
      await page.keyboard.press('Control+L')
      await page.waitForTimeout(100)
      const cleared=await terminal.locator('.xterm-rows').textContent()??''
      if(cleared.split('project $ echo before-clear').length!==2)
        throw Error(`${name} Ctrl+L did not keep one editable command: ${cleared}`)
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
    }
    if(process.env.NATIVE_WORD_EDIT==='1'){
      await input.focus()
      await page.keyboard.type('echo alpha beta   ')
      await page.keyboard.press('Control+W')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $ echo alpha'),undefined,{timeout:5000})
        .catch(async error=>{throw Error(`${name} Ctrl+W state: ${await terminal.locator('.xterm-rows').textContent()}`,{cause:error})})
      await page.keyboard.type('gamma')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('echo alpha gammaalpha gamma')&&text.trimEnd().endsWith('project $')
      },undefined,{timeout:30000})
      await page.keyboard.type('echo first second')
      await page.keyboard.press('Alt+Backspace')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $ echo first'),undefined,{timeout:5000})
        .catch(async error=>{throw Error(`${name} Alt+Backspace state: ${await terminal.locator('.xterm-rows').textContent()}`,{cause:error})})
      await page.keyboard.press('Control+C')
    }
    if(process.env.NATIVE_EDIT==='1'){
      await page.keyboard.type('echo edis')
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.type('t')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('edit s')||text.includes('editsproject $')
      },undefined,{timeout:30000})
      const text=await terminal.locator('.xterm-rows').textContent()??''
      if(!text.includes('edits'))throw Error(`${name} cursor insertion failed: ${text}`)
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Home')
      await page.keyboard.type('x')
      await page.keyboard.press('Backspace')
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.split('edits').length>=4&&text.trimEnd().endsWith('project $')
      },undefined,{timeout:30000})
    }
    if(process.env.NATIVE_RESIZE==='1'){
      const readSize=async(count)=>{
        await page.keyboard.type('stty size')
        await page.keyboard.press('Enter')
        try{await page.waitForFunction(count=>{
          const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
          return [...text.matchAll(/stty size(\d+) (\d+)project \$/g)].length>=count
        },count,{timeout:30000})}
        catch(error){throw Error(`${name} did not show stty size: ${await terminal.locator('.xterm-rows').textContent()}`,{cause:error})}
        const text=await terminal.locator('.xterm-rows').textContent()??''
        const match=[...text.matchAll(/stty size(\d+) (\d+)project \$/g)].at(-1)
        if(!match)throw Error(`${name} did not report terminal size: ${text}`)
        return {rows:Number(match[1]),columns:Number(match[2])}
      }
      const before=await readSize(1)
      const handle=page.getByRole('separator',{name:'Resize preview and terminal panels'})
      const percentBefore=Number(await handle.getAttribute('aria-valuenow'))
      const screenRowsBefore=await terminal.locator('.xterm-rows').evaluate(element=>element.children.length)
      // A native pointer click must transfer keyboard focus to the splitter.
      // Programmatic focus would miss preventDefault suppressing that transfer.
      await handle.click()
      await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Resize preview and terminal panels',undefined,{timeout:5000})
      for(let i=0;i<8;i++)await page.keyboard.press('ArrowUp')
      await page.waitForFunction(previous=>{
        const handle=document.querySelector('[aria-label="Resize preview and terminal panels"]')
        return Number(handle?.getAttribute('aria-valuenow'))>previous
      },percentBefore,{timeout:5000})
      await page.waitForFunction(previous=>document.querySelector('[data-native-terminal] .xterm-rows')?.children.length!==previous,screenRowsBefore,{timeout:5000})
      const percentAfter=Number(await handle.getAttribute('aria-valuenow'))
      const measured=await terminal.locator('.xterm-screen').evaluate(element=>({height:element.getBoundingClientRect().height,rows:element.querySelector('.xterm-rows')?.children.length}))
      await input.focus()
      const after=await readSize(2)
      if(before.rows===after.rows)throw Error(`${name} process did not receive terminal resize: ${JSON.stringify({before,after,percentBefore,percentAfter,measured})}`)
      console.log(`${name}: terminal resize reached child process ${before.rows}x${before.columns} -> ${after.rows}x${after.columns}`)
    }
    if(process.env.NATIVE_SCROLLBACK_FOLLOW==='1'){
      await command('node -e \'for(let i=0;i<80;i++)console.log("HISTORY "+i)\'','HISTORY 79','project $')
      const view=nativeTerminalScreen(terminal,page)
      phase='scrollback input follow'
      const top=await renderedTerminalEdge(view,-1,{requireMovement:true})
      await input.focus()
      await page.keyboard.type('echo FOLLOW_INPUT')
      await page.waitForFunction(top=>{
        const terminal=document.querySelector('[data-native-terminal]')
        const rows=terminal.querySelector('.xterm-rows').textContent
        return rows!==top.screen&&rows.trimEnd().endsWith('project $ echo FOLLOW_INPUT')
      },top,{timeout:5000})
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('FOLLOW_INPUTproject $'),undefined,{timeout:30000})
      phase='scrollback background output'
      await page.keyboard.type('node -e \'let i=0;setInterval(()=>console.log("BACKGROUND "+i++),30)\'')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.includes('BACKGROUND 30'),undefined,{timeout:10000})
      const anchor=await renderedTerminalEdge(view,-1,{requireMovement:true})
      await page.waitForTimeout(300)
      if((await view.read())!==anchor.screen)
        throw Error(`${name} background output pulled the user out of scrollback`)
      phase='scrollback background interrupt'
      await page.keyboard.press('Control+C')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
    }
    const previewDocumentCount=()=>previewEvents.filter(event=>event.type==='document'&&event.event==='start').length
    const beforeUnrelatedWrites=previewDocumentCount()
    await command('mkdir -p work && cd work && pwd','/project/work','work $')
    await command('printf "41\\n" | cat > /project/count.txt','work $','work $')
    await page.waitForTimeout(1500)
    if(previewDocumentCount()!==beforeUnrelatedWrites)throw Error(`${name} unrelated/data file writes restarted the preview document`)
    if(process.env.NATIVE_NODE_EVAL==='1'){
      await command('node -e \'console.log(41 + 1, process.argv[1])\' hello','42 hello','work $')
      await command('node --eval \'console.log(require("node:fs").existsSync("../package.json"))\'','true','work $')
      await command('node -e \'console.log(require("./node_modules/react/package.json").name)\'','react','work $')
      await command('node -e \'setTimeout(() => console.log("later"), 20)\'','later','work $')
    }
    const frame=page.frames().find(item=>item.url()===previewOrigin+'/')
    if(!frame)throw Error('Preview frame missing')
    const previewClickTarget=process.env.NATIVE_TRACE_PREVIEW_INPUT==='1'
      ?await diagnosticWithin(()=>frame.getByRole('button',{name:/Add 1 to/}).boundingBox({timeout:1000})):undefined
    const inspectPreview=(action='inspect')=>page.evaluate(({previewOrigin,action})=>new Promise(resolve=>{
      const frame=document.querySelector('iframe[title="Workspace preview"]')
      if(!(frame instanceof HTMLIFrameElement)||!frame.contentWindow){resolve({error:'Preview iframe is missing'});return}
      const channel=new MessageChannel()
      const timer=setTimeout(()=>{channel.port1.close();resolve({error:'Inspection handshake timed out'})},3000)
      channel.port1.onmessage=({data})=>{
        if(data?.type==='ready')channel.port1.postMessage({id:1,type:action,...(action==='click'?{selector:'button'}:{})})
        if(data?.type==='result'){clearTimeout(timer);channel.port1.close();resolve(data)}
      }
      channel.port1.start()
      frame.contentWindow.postMessage({type:'inspect-workspace'},previewOrigin,[channel.port2])
    }),{previewOrigin,action})
    phase='counter reload 1'
    await page.getByRole('button',{name:'Reload preview',exact:true}).click()
    await frame.getByRole('button',{name:'Add 1 to 41?'}).waitFor({timeout:process.env.NATIVE_START_CHANGED_INSTALL==='1'?15000:45000}).catch(async error=>{
      const fetchResult=await diagnosticWithin(()=>frame.evaluate(async()=>{
        try{
          const response=await fetch('/node_modules/@tanstack/react-start/dist/plugin/default-entry/client.tsx',
            {signal:AbortSignal.timeout(5000)})
          return {status:response.status,body:(await response.text()).slice(0,1500)}
        }catch(cause){return {error:String(cause)}}
      }))
      const documentState=await diagnosticWithin(()=>frame.evaluate(()=>({readyState:document.readyState,
        html:document.documentElement?.outerHTML.slice(0,2000),
        resources:performance.getEntriesByType('resource').slice(-10).map(entry=>({name:entry.name,duration:entry.duration}))}))
      )
      const body=await diagnosticWithin(()=>frame.locator('body').innerText({timeout:1000}))
      const currentPreview=await diagnosticWithin(async()=>{
        const element=await page.locator('iframe[title="Workspace preview"]').elementHandle({timeout:1000})
        const current=await element?.contentFrame()
        return {sameFrame:current===frame,oldDetached:frame.isDetached(),currentURL:current?.url(),frames:page.frames().map(item=>({url:item.url(),detached:item.isDetached(),sameAsSelected:item===frame}))}
      })
      const previewInspection=await diagnosticWithin(inspectPreview)
      const inspectionInput=process.env.NATIVE_TRACE_PREVIEW_CLICK==='1'
        ?await diagnosticWithin(async()=>{
          // Diagnostic only, a working handler does not erase the frame failure.
          const clicked=await inspectPreview('click')
          await page.waitForTimeout(1000)
          return {clicked,after:await inspectPreview()}
        }):undefined
      const physicalInput=previewClickTarget&&typeof previewClickTarget.x==='number'
        ?await diagnosticWithin(async()=>{
          // Diagnostic only, the original frame assertion still fails below.
          // Use the measured button position, never guess screenshot coordinates.
          await page.mouse.click(previewClickTarget.x+previewClickTarget.width/2,previewClickTarget.y+previewClickTarget.height/2)
          await page.waitForTimeout(1000)
          return {target:previewClickTarget,after:await inspectPreview()}
        }):undefined
      throw Error(`${name} preview did not recover: ${JSON.stringify({url:frame.url(),body:typeof body==='string'?body.slice(0,1200):body,pageErrors,consoleErrors,moduleEvents,failedModules,fetchResult,documentState,currentPreview,previewInspection,inspectionInput,physicalInput})}`,{cause:error})
    })
    if(process.env.NATIVE_EDITOR_TO_TERMINAL==='1'){
      // Prove the reloaded SSR page is interactive, not just rendered.
      // The pinned Counter mounts this existing control in a client effect.
      // Network idle alone can precede asynchronous route hydration.
      await frame.getByText('TanStack Router',{exact:true}).waitFor({timeout:45000})
      await frame.getByRole('button',{name:'Add 1 to 41?'}).click()
      await frame.getByRole('button',{name:'Add 1 to 42?'}).waitFor({timeout:45000})
      phase='editor change'
      const editor=page.getByRole('textbox',{name:'Edit /src/routes/index.tsx'})
      const original=await editor.evaluate(element=>element.cmTile.view.state.doc.toString())
      if(!original.includes('Add 1 to'))throw Error(`${name} counter source is missing`)
      await editor.fill(original.replace('Add 1 to','Add one to'))
      await frame.getByRole('button',{name:'Add one to 42?'}).waitFor({timeout:45000})
      await frame.getByRole('button',{name:'Add one to 42?'}).click()
      await frame.getByRole('button',{name:'Add one to 43?'}).waitFor({timeout:45000})
      await command('cat ../src/routes/index.tsx','Add one to','work $')
      phase='editor restore'
      await editor.fill(original)
      await frame.getByRole('button',{name:'Add 1 to 43?'}).waitFor({timeout:45000})
      await command('cat ../src/routes/index.tsx','Add 1 to','work $')
    }
    if(process.env.NATIVE_STDIN==='1'){
      await page.keyboard.type('cat')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(250)
      await page.keyboard.type('hello from terminal')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.split('hello from terminal').length-1>=2
      },undefined,{timeout:10000})
      await page.keyboard.press('Control+D')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('work $'),undefined,{timeout:10000})
    }
    if(process.env.NATIVE_STDIN_PASTE==='1'){
      await page.keyboard.type('cat')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(250)
      await paste('paste-one\npaste-two\n')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.split('paste-one').length-1>=2&&text.split('paste-two').length-1>=2
      },undefined,{timeout:5000})
      await paste('paste-three')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.split('paste-three').length-1>=2
      },undefined,{timeout:5000})
      await page.keyboard.press('Control+D')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('work $'),undefined,{timeout:10000})
    }
    if(process.env.NATIVE_INTERRUPT==='1'){
      await page.keyboard.type('sleep 10')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(250)
      const interruptedAt=Date.now()
      await page.keyboard.press('Control+C')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('work $'),undefined,{timeout:5000})
      if(Date.now()-interruptedAt>5000)throw Error('Ctrl-C did not return the terminal prompt promptly')
      await page.keyboard.type('printf "after\\n"')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('after')&&text.trimEnd().endsWith('work $')
      },undefined,{timeout:10000})
    }
    if(process.env.NATIVE_NODE_EVAL_INTERRUPT==='1'){
      await page.keyboard.type('node -e \'setInterval(() => console.log("tick"), 100)\'')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.includes('tick'),undefined,{timeout:10000})
      await page.keyboard.press('Control+C')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('work $'),undefined,{timeout:5000})
      const stopped=await terminal.locator('.xterm-rows').textContent()
      await page.waitForTimeout(350)
      if(await terminal.locator('.xterm-rows').textContent()!==stopped)throw Error(`${name} inline Node process wrote after Ctrl+C`)
      await command('pwd','/project/work','work $')
    }
    if(process.env.NATIVE_TYPEAHEAD==='1'){
      await page.keyboard.type('sleep 10')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+C')
      await page.keyboard.type('printf "TYPEAHEAD_%s\\n" "OK"')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('TYPEAHEAD_OK')&&text.trimEnd().endsWith('work $')
      },undefined,{timeout:10000}).catch(async error=>{throw Error(`${name} typeahead after Ctrl+C: ${await terminal.locator('.xterm-rows').textContent()}`,{cause:error})})
    }
    if(process.env.NATIVE_INTERRUPT_BUILD==='1'){
      await page.keyboard.type('pnpm run build')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('vite build && tsc --noEmit')
      },undefined,{timeout:30000})
      await page.keyboard.press('Control+C')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('work $'),undefined,{timeout:5000})
      await command('pwd','/project/work','work $')
      await page.waitForTimeout(1000)
      const text=await terminal.locator('.xterm-rows').textContent()??''
      if(/built in \d+ms/.test(text))throw Error(`${name} interrupted build continued after Ctrl-C: ${text}`)
    }
    if(process.env.NATIVE_BUILD==='1'){
      await command('pnpm run build',/built in \d+(?:\.\d+)?(?:ms|s)/,'work $')
      const failure=await scrollbackContains('Exited with code')
      if(failure.found)throw Error(`${name} package build reported a failure: ${[...new Set(failure.screens)].join('\n[scroll]\n')}`)
      if(process.env.NATIVE_CAPTURE_BUILD==='1')console.log(`${name} build output: ${await terminal.locator('.xterm-rows').textContent()}`)
      await command('ls -a /project','dist','work $')
    }
    if(process.env.NATIVE_TYPECHECK_ERROR==='1'){
      await command('printf "const mismatch: string = 42\\n" > /project/src/type-error.ts','work $','work $')
      await command('pnpm run build','error TS2322','work $')
      const output=await terminal.locator('.xterm-rows').textContent()??''
      if(!output.includes('Exited with code 2'))throw Error(`${name} typecheck error did not fail the script: ${output}`)
      await command('rm /project/src/type-error.ts','work $','work $')
    }
    if(process.env.NATIVE_RAW_VITE==='1'){
      await command('cd /project && ./node_modules/.bin/vite --version',/vite\/\d+\.\d+\.\d+/,'project $')
      if(process.env.NATIVE_RAW_VITE_VERSION_ONLY!=='1'){
        await command(`cd /project && ./node_modules/.bin/vite build${process.env.NATIVE_RAW_VITE_RUNNER==='1'?' --configLoader runner':''}; printf "\\nRAW_VITE_EXIT:%s\\n" "$?"`,'RAW_VITE_EXIT:0','project $')
        await command('ls -a /project','dist','project $')
      }
      await command('cd /project/work && pwd','/project/work','work $')
    }
    if(process.env.NATIVE_VITE_DEV==='1'){
      await command('cd /project','/project','project $')
      await input.focus()
      await page.keyboard.type(process.env.NATIVE_VITE_DEV_RUNNER==='1'
        ?'./node_modules/.bin/vite dev --configLoader runner':'pnpm run dev')
      await page.keyboard.press('Enter')
      const readScrollback=async()=>{
        if(await terminal.locator('.xterm-scrollable-element').count()){
          const view=nativeTerminalViewport(terminal,page)
          const scanned=await renderedTerminalScan(view,()=>false)
          await renderedTerminalEdge(view,1)
          return scanned.screens.join('\n[scroll]\n')
        }
        const viewport=terminal.locator('.xterm-viewport')
        const height=await viewport.evaluate(element=>element.scrollHeight)
        const screens=[]
        for(let top=0;top<=height;top+=24){
          await viewport.evaluate((element,value)=>{element.scrollTop=value},top)
          const text=await terminal.locator('.xterm-rows').textContent()
          if(screens.at(-1)!==text)screens.push(text)
        }
        await viewport.evaluate((element,value)=>{element.scrollTop=value},height)
        return [...new Set(screens)].join('\n[scroll]\n')
      }
      let output=''
      const deadline=Date.now()+45000
      do{
        output=await readScrollback()
        if(/ready in|Local:|Exited with code/.test(output))break
        await page.waitForTimeout(500)
      }while(Date.now()<deadline)
      if(/ready in|Local:/.test(output)){
        await page.waitForTimeout(3000)
        output=await readScrollback()
      }
      if(!/ready in|Local:/.test(output)||/Failed to run dependency scan|Failed to resolve dependency|Exited with code/.test(output))
        throw Error(`${name} terminal Vite dev did not become usable: ${output.slice(-16000)}`)
      if(output.trimEnd().endsWith('project $'))throw Error(`${name} terminal Vite dev exited after startup: ${output}`)
      await page.keyboard.press('Control+C')
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:10000})
      await command('pwd','/project','project $')
      await command('cd /project/work && pwd','/project/work','work $')
    }
    if(process.env.NATIVE_NODE==='1'){
      await command("printf 'console.log(42)\\n' > run.mjs",'work $','work $')
      await command('node run.mjs','42','work $')
      await command('cat run.mjs','console.log(42)','work $')
    }
    if(process.env.NATIVE_UNHANDLED==='1'){
      await command('printf "Promise.reject(new Error(\\\"unhandled probe\\\"))\\n" > reject.mjs','work $','work $')
      await command('node reject.mjs','Exited with code 1','work $')
      const immediate=await scrollbackContains('Error: unhandled probe')
      if(!immediate.found)
        throw Error(`${name} did not show the immediate rejection reason in terminal scrollback (${immediate.height}px): ${[...new Set(immediate.screens)].join('\n[scroll]\n')}`)
      await command('printf "setTimeout(() => Promise.reject(new Error(\\\"async unhandled probe\\\")), 10)\\n" > async-reject.mjs','work $','work $')
      await command('node async-reject.mjs','Exited with code 1','work $')
      const asynchronous=await scrollbackContains('Error: async unhandled probe')
      if(!asynchronous.found)
        throw Error(`${name} did not show the asynchronous rejection reason in terminal scrollback (${asynchronous.height}px): ${[...new Set(asynchronous.screens)].join('\n[scroll]\n')}`)
    }
    if(process.env.NATIVE_RESTART_ACTIVE_COMMAND==='1'){
      await input.focus()
      await page.keyboard.type('sleep 30')
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.includes('sleep 30')&&!text.trimEnd().endsWith('work $')
      },undefined,{timeout:10000})
      const oldPreview=await page.locator('iframe[title="Workspace preview"]').elementHandle()
      if(!oldPreview)throw Error(`${name} preview frame missing before active-command restart`)
      const restartedAt=Date.now()
      await page.getByRole('button',{name:'Run',exact:true}).click()
      await page.waitForFunction(frame=>!frame.isConnected,oldPreview,{timeout:30000})
      if(Date.now()-restartedAt>=25000)throw Error(`${name} waited for the foreground command instead of disposing it on restart`)
      await page.locator('[data-native-preview-ready="true"]').waitFor({timeout:180000})
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
      if(process.env.NATIVE_FOCUS_BEHAVIOR==='1')await expectTerminalFocus('restart during a command')
      await command('pwd','/project','project $')
    }
    if(process.env.NATIVE_RESTART_ACTIVE_PORT==='1'){
      await input.focus()
      await page.keyboard.type("node -e 'const http=require(\"node:http\");http.createServer((request,response)=>response.end(\"alive\")).listen(48777,()=>console.log(\"bound\"))'")
      await page.keyboard.press('Enter')
      await page.waitForFunction(()=>{
        const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
        return text.split('bound').length>=3&&!text.trimEnd().endsWith('work $')
      },undefined,{timeout:15000})
      const oldPreview=await page.locator('iframe[title="Workspace preview"]').elementHandle()
      if(!oldPreview)throw Error(`${name} preview frame missing before active-port restart`)
      await page.getByRole('button',{name:'Run',exact:true}).click()
      await page.waitForFunction(frame=>!frame.isConnected,oldPreview,{timeout:30000})
      await page.locator('[data-native-preview-ready="true"]').waitFor({timeout:180000})
      await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
      await command("node -e 'const http=require(\"node:http\");const server=http.createServer();server.listen(48777,()=>{console.log(\"rebound\");server.close()})'",'rebound','project $')
      const rebound=await terminal.locator('.xterm-rows').textContent()??''
      if(rebound.split('rebound').length<3||rebound.includes('EADDRINUSE')||rebound.includes('Exited with code'))
        throw Error(`${name} foreground server port was not released on restart: ${rebound}`)
      await command('pwd','/project','project $')
    }
    if(process.env.NATIVE_RESTART_CYCLES==='1'){
      const restartCount=Number(process.env.NATIVE_RESTART_COUNT??3)
      if(!Number.isInteger(restartCount)||restartCount<1||restartCount>20)throw Error('NATIVE_RESTART_COUNT must be an integer from 1 to 20')
      for(let cycle=0;cycle<restartCount;cycle++){
        const oldPreview=await page.locator('iframe[title="Workspace preview"]').elementHandle()
        if(!oldPreview)throw Error(`${name} preview frame missing before restart ${cycle+1}`)
        await page.getByRole('button',{name:'Run',exact:true}).click()
        await page.waitForFunction(frame=>!frame.isConnected,oldPreview,{timeout:30000})
        await page.locator('[data-native-preview-ready="true"]').waitFor({timeout:180000})
        await page.waitForFunction(()=>document.querySelector('[data-native-terminal] .xterm-rows')?.textContent?.trimEnd().endsWith('project $'),undefined,{timeout:30000})
        if(process.env.NATIVE_FOCUS_BEHAVIOR==='1')await expectTerminalFocus(`restart ${cycle+1}`)
        await command('pwd','/project','project $')
        console.log(`${name}: restart ${cycle+1}/${restartCount} passed`)
      }
    }
    const unexpectedErrors=unexpectedPreviewErrors(pageErrors,documentTraces,failedPreviewRequests)
    if(unexpectedErrors.length)throw Error(`${name} terminal workflow page errors: ${unexpectedErrors.join('; ')}`)
    if(failedModules.length)throw Error(`${name} terminal workflow failed client modules: ${JSON.stringify(failedModules)}`)
    if(process.env.NATIVE_TERMINAL_CAPTURE){
      await page.waitForTimeout(1500)
      console.log(`${name} preview text before capture: ${JSON.stringify((await frame.locator('body').innerText()).slice(0,200))}`)
      await page.screenshot({path:process.env.NATIVE_TERMINAL_CAPTURE.replace('{browser}',name)})
    }
    console.log(`${name}: visible terminal shell, cwd, pipeline, file write, preview refresh${process.env.NATIVE_EDITOR_TO_TERMINAL==='1'?', editor to terminal sync':''}${process.env.NATIVE_TOGGLE_TERMINAL==='1'?', terminal hide and reopen':''}${process.env.NATIVE_UNSUPPORTED==='1'?', unsupported command exit and recovery':''}${process.env.NATIVE_TAB_SWITCH==='1'?', process-tab switch during command':''}${process.env.NATIVE_HIDE_PREVIEW==='1'?', preview toggle while terminal stays open':''}${process.env.NATIVE_TREE_COMMANDS==='1'?', recursive file commands':''}${process.env.NATIVE_INSTALL==='1'?', pnpm install':''}${process.env.NATIVE_START_CHANGED_INSTALL==='1'?', changed-dependency install':''}${process.env.NATIVE_INSTALL_INTERRUPT==='1'?', install interruption and recovery':''}${process.env.NATIVE_INSTALL_FAILURE==='1'?', failed install and recovery':''}${process.env.NATIVE_COMPLETE==='1'?', command and path completion':''}${process.env.NATIVE_PASTE==='1'?', clipboard paste':''}${process.env.NATIVE_LONG_EDIT==='1'?', wrapped editing':''}${process.env.NATIVE_CLEAR_EDIT==='1'?', Ctrl+L':''}${process.env.NATIVE_NODE==='1'?', node script':''}${process.env.NATIVE_RAW_VITE==='1'?', direct Vite CLI build':''}${process.env.NATIVE_VITE_DEV==='1'?', foreground Vite dev and Ctrl-C':''}${process.env.NATIVE_RESTART_ACTIVE_COMMAND==='1'?', active-command restart and disposal':''}${process.env.NATIVE_RESTART_ACTIVE_PORT==='1'?', active-server port release on restart':''}${process.env.NATIVE_RESTART_CYCLES==='1'?', repeated restart cycles':''}${process.env.NATIVE_INTERRUPT_BUILD==='1'?', build interruption and recovery':''}${process.env.NATIVE_BUILD==='1'?', package build':''}${process.env.NATIVE_UNHANDLED==='1'?', command rejection exits':''} passed`)
  }catch(error){
    console.error(JSON.stringify({browser:name,repetition,phase,error:String(error)}))
    if(process.env.NATIVE_TERMINAL_FAILURE_REPORT){
      await writeFile(process.env.NATIVE_TERMINAL_FAILURE_REPORT,JSON.stringify({
        browser:name,browserVersion:browser.version(),headless,failureHoldMs,repetition,phase,url,error:String(error),stack:error.stack,pageErrors,failedModules,previewEvents,documentTraces,failedPreviewRequests,
        terminal:await page?.locator('[data-native-terminal] .xterm-rows').textContent({timeout:1000}).catch(()=>null),
        workbench:await page?.locator('[data-native-preview-ready]').innerText({timeout:1000}).catch(()=>null),
        previewDocuments:await Promise.all((page?.frames()??[]).filter(frame=>frame.url().startsWith(previewOrigin+'/')).map(async frame=>({url:frame.url(),state:await diagnosticWithin(()=>frame.evaluate(()=>({readyState:document.readyState,resources:performance.getEntriesByType('resource').slice(-12).map(entry=>({name:entry.name,duration:entry.duration}))})))}))),
      },null,2)+'\n')
    }
    if(process.env.NATIVE_TERMINAL_FAILURE_CAPTURE&&page)
      await page.screenshot({path:process.env.NATIVE_TERMINAL_FAILURE_CAPTURE}).catch(()=>{})
    if(failureHoldMs>0&&page&&!page.isClosed()&&browser.isConnected()){
      // Capture the original failure first. Native input during this diagnostic
      // hold cannot make the original workflow pass, it still throws below.
      phase='failed workflow retained for native-input diagnosis'
      console.log('[native-terminal-failure-held] '+JSON.stringify({browser:name,browserVersion:browser.version(),repetition,holdMs:failureHoldMs}))
      await new Promise(resolve=>setTimeout(resolve,failureHoldMs))
    }else if(failureHoldMs>0){
      console.log('[native-terminal-failure-unavailable] '+JSON.stringify({browser:name,repetition,pageClosed:!page||page.isClosed(),browserConnected:browser.isConnected()}))
    }
    throw error
  }finally{clearInterval(progressTimer);await browser.close()}
}
