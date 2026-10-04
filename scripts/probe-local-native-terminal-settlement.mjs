import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {siteRepeatOptions} from './repeat-local-native-site.mjs'
import {componentControlInputs} from './serve-native-reload-components.mjs'
import {readPinnedNativeExamples} from './native-example-sources.mjs'
import {terminalMatrixProject} from './probe-local-native-terminal-matrix.mjs'
import {nativeTerminalScreen} from './native-terminal-screen.mjs'
import {renderedTerminalEdge,renderedTerminalScan} from './native-terminal-viewport.mjs'

const root=fileURLToPath(new URL('..',import.meta.url))
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const example='start-streaming-data-from-server-functions'

export function terminalSettlementComplete(row,groups=20){
  if(!row.preparationComplete||!row.inputsUnchanged||row.commands.length!==groups*3)return false
  return row.commands.every((command,index)=>command.passed&&command.group===Math.floor(index/3)+1&&
    command.kind===['source-output','missing-command','after-failure'][index%3])
}

export function terminalCommandSettled(screen,marker,exitCode){
  return typeof screen==='string'&&typeof marker==='string'&&marker.length>0&&Number.isInteger(exitCode)&&
    screen.includes(marker+':'+exitCode)&&screen.trimEnd().endsWith('project $')
}

export function terminalSettlementLine(line,marker){
  assert.match(marker,/^TERMINAL_SETTLED_\d+$/)
  return line+'; __terminal_settlement_status=$?; printf "\\n'+marker+':%s\\n" "$__terminal_settlement_status"; (exit "$__terminal_settlement_status")'
}

async function main(){
  const options=siteRepeatOptions(process.argv.slice(2))
  assert.equal(options.browser,'all','Settlement control requires all three engines')
  assert.equal(options.runs,1,'Use one original sequence per engine followed by twenty command groups')
  assert.ok(options.runner,'Pass the locked browser runner')
  const runner=createRequire(join(options.runner,'package.json'))
  const dependencies=dirname(realpathSync(join(options.runner,'node_modules')))
  const lockPath=join(dependencies,'package-lock.json')
  const lock=JSON.parse(readFileSync(lockPath))
  for(const name of ['playwright','playwright-core','@playwright/test'])
    assert.equal(runner(name+'/package.json').version,lock.packages['node_modules/'+name].version)
  assert.equal(runner('playwright/package.json').version,'1.63.0')
  const {chromium,firefox,webkit}=runner('playwright')
  const examplePath=join(options.fixture,'.native-local',example+'.json')
  const identity=()=>{
    const {project,...inputs}=componentControlInputs({...options,mode:'workbench'},root)
    const expected=readPinnedNativeExamples(root).examples.get('react/'+example)
    terminalMatrixProject(JSON.parse(readFileSync(examplePath)),expected)
    return {...inputs,example:{revision:expected.revision,sourceSHA256:expected.sourceSHA256,npmLockSHA256:expected.npmLockSHA256},
      exampleFileSHA256:hash(examplePath),driverSHA256:hash(fileURLToPath(import.meta.url)),
      siteFiles:Object.fromEntries(['package.json','pnpm-lock.yaml','vite.config.ts'].map(path=>[path,hash(join(options.fixture,path))])),
      viewportHelpers:Object.fromEntries(['scripts/native-terminal-screen.mjs','scripts/native-terminal-viewport.mjs'].map(path=>[path,hash(join(root,path))])),
      runnerLockSHA256:hash(lockPath),browserCatalogSHA256:hash(join(dirname(runner.resolve('playwright-core/package.json')),'browsers.json'))}
  }
  const before=identity(),directory=mkdtempSync('/private/tmp/native-terminal-settlement-')
  const report={scope:'Real-site Streaming terminal source-output/missing-command settlement control. Host errors remain diagnostics, not error-free site, production or streaming acceptance.',
    identity:before,groups:20,rows:[],complete:false,passed:false}
  const save=()=>writeFileSync(join(directory,'results.json'),JSON.stringify(report,null,2)+'\n')
  console.log('NATIVE_TERMINAL_SETTLEMENT_REPORT '+join(directory,'results.json'));save()
  try{
    for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
      const browser=await engine.launch({headless:true})
      const row={browser:name,version:browser.version(),commands:[],preparation:[],hostErrors:[],phase:'startup',preparationComplete:false,passed:false}
      report.rows.push(row);save()
      try{
        const page=await browser.newPage({viewport:{width:1440,height:900}})
        page.on('pageerror',error=>row.hostErrors.push(String(error)))
        await page.goto(options.site+'/start/latest/docs/framework/react/examples/'+example+'?panel=playground',
          {waitUntil:'domcontentloaded',timeout:120000})
        await page.locator('[data-native-preview-ready="true"]').waitFor({timeout:180000})
        await page.getByRole('button',{name:'Show terminal'}).click()
        await page.getByRole('button',{name:'Terminal',exact:true}).click()
        const terminal=page.getByRole('region',{name:'Sandbox terminal'})
        const input=terminal.locator('textarea[aria-label="Sandbox terminal"]')
        let commandNumber=0
        const command=async(line,expected,record)=>{
          row.phase=line
          const marker='TERMINAL_SETTLED_'+(++commandNumber)
          const exitCode=line==='definitely-not-installed-command'?127:0
          const wireLine=terminalSettlementLine(line,marker)
          const item={line,wireLine,marker,exitCode,expected,passed:false,...record},started=performance.now()
          ;(record?row.commands:row.preparation).push(item);save()
          await input.focus()
          item.focusBeforeTyping=await input.evaluate(element=>document.activeElement===element)
          await page.keyboard.type(wireLine)
          item.focusBeforeEnter=await input.evaluate(element=>document.activeElement===element)
          await page.keyboard.press('Enter')
          try{
            await page.waitForFunction(({marker,exitCode})=>{
              const text=document.querySelector('[data-native-terminal] .xterm-rows')?.textContent??''
              return text.includes(marker+':'+exitCode)&&text.trimEnd().endsWith('project $')
            },{marker,exitCode},{timeout:30000})
            const text=await terminal.locator('.xterm-rows').textContent()
            assert.equal(terminalCommandSettled(text,marker,exitCode),true)
            if(!text.includes(expected)){
              const view=nativeTerminalScreen(terminal,page)
              const scan=await renderedTerminalScan(view,text=>text?.includes(expected))
              await renderedTerminalEdge(view,1)
              assert.equal(scan.found,true,'Command completed without expected output in scrollback: '+line)
              item.outputFoundInScrollback=true
            }
            assert.equal(item.focusBeforeTyping,true);assert.equal(item.focusBeforeEnter,true)
            item.passed=true
          }finally{
            item.elapsedMs=Math.round(performance.now()-started)
            item.screen=(await terminal.locator('.xterm-rows').textContent().catch(()=>''))?.slice(-4000)
            save()
          }
        }
        await command('pwd','/project')
        await command('printf "terminal proof\\n" > terminal-proof.txt','project $')
        await command('cat terminal-proof.txt','terminal proof')
        const showFiles=page.getByRole('button',{name:'Show files'})
        if(await showFiles.count())await showFiles.click()
        await page.getByText('terminal-proof.txt',{exact:true}).first().click()
        const editor=page.getByRole('textbox',{name:'Edit /terminal-proof.txt'})
        await editor.waitFor({timeout:30000})
        assert.equal(await editor.evaluate(element=>element.cmTile.view.state.doc.toString()),'terminal proof\n')
        await command('cat src/routes/index.tsx','Typed Readable Stream')
        await command('node -e \'console.log(require("node:fs").readFileSync("src/routes/index.tsx","utf8").includes("Typed Readable Stream"))\'','true')
        const patch='const fs=require("node:fs");const p="src/routes/index.tsx";const s=fs.readFileSync(p,"utf8");if(!s.includes("Typed Readable Stream"))process.exit(2);fs.writeFileSync(p,s.replace("Typed Readable Stream","Terminal Typed Stream"))'
        await command("node -e '"+patch+"'",'project $')
        await command('cat src/routes/index.tsx','Terminal Typed Stream')
        await page.frameLocator('iframe[title="Workspace preview"]').getByText('Terminal Typed Stream',{exact:false}).waitFor({timeout:45000})
        row.preparationComplete=true;save()
        for(let group=1;group<=20;group++){
          await command('cat src/routes/index.tsx','asyncGeneratorFuncMessages',{group,kind:'source-output'})
          await command('definitely-not-installed-command','Exited with code 127',{group,kind:'missing-command'})
          await command('printf "SETTLED:'+group+'\\n"','SETTLED:'+group,{group,kind:'after-failure'})
        }
        assert.deepEqual(identity(),before,'Settlement inputs changed')
        row.inputsUnchanged=true
        row.passed=terminalSettlementComplete(row)
        assert.equal(row.passed,true)
        console.log('NATIVE_TERMINAL_SETTLEMENT_ROW '+JSON.stringify({browser:name,commands:row.commands.length,hostErrors:row.hostErrors,passed:row.passed}))
      }catch(error){row.error=String(error);console.error(name,row.phase,row.error)}
      finally{await browser.close();save()}
    }
    assert.deepEqual(identity(),before,'Settlement inputs changed after the run')
    report.inputsUnchanged=true
    report.complete=report.rows.length===3
    report.passed=report.complete&&report.rows.every(row=>row.passed)
  }finally{save()}
  if(!report.passed)process.exitCode=1
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
