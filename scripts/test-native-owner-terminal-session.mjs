import assert from 'node:assert/strict'
import {chromium,firefox,webkit} from 'playwright'

const site=process.env.NATIVE_SITE_ORIGIN??'http://127.0.0.1:4268'
const owner=process.env.NATIVE_OWNER_ORIGIN??'http://127.0.0.1:4267'
for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
  const browser=await engine.launch({headless:true})
  try{
    const page=await browser.newPage()
    page.on('pageerror',error=>console.error(name,'pageerror',error.message))
    if(process.env.NATIVE_VERBOSE==='1')page.on('console',message=>console.error(name,'console',message.text()))
    await page.goto(site+'/')
    const result=await page.evaluate(async ownerOrigin=>{
      const {NativeOwnerClient}=await import('/sdk/index.js')
      const frame=document.createElement('iframe')
      frame.allow='cross-origin-isolated'
      frame.style.cssText='position:absolute;width:1px;height:1px;opacity:0'
      document.body.append(frame)
      const ready=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(Error('Owner frame did not load'))},15000)
        const listener=event=>{
          if(event.source!==frame.contentWindow||event.origin!==ownerOrigin||event.data!=='native-owner-ready')return
          clearTimeout(timer);window.removeEventListener('message',listener);resolve()
        }
        window.addEventListener('message',listener)
      })
      frame.src=ownerOrigin+'/owner.html'
      await ready
      const client=await NativeOwnerClient.connect(frame.contentWindow,ownerOrigin)
      console.log('owner-connected')
      const events=[]
      client.subscribeEvents(event=>{events.push(event);if(event.type==='progress'||event.type==='diagnostic')console.log('owner-event',event.type,event.type==='progress'?event.phase:event.error)})
      try{
        await client.start({
          '/project/index.mjs':'export default {fetch(){return new Response("ready")}}',
          '/project/answer.txt':'old',
        },{workspaceRoot:'/project',entry:'/project/index.mjs',serveFetchEntry:true,installDependencies:false})
        console.log('project-started')
        let invalidSizeRejected=false
        try{await client.openTerminalCommand('pwd','/project',undefined,undefined,{columns:0,rows:20}).result}
        catch(error){invalidSizeRejected=String(error).includes('Invalid terminal size')}
        const oneShot=await client.openTerminalCommand('stty size','/project',undefined,undefined,{columns:93,rows:27}).result
        const session=await client.openTerminalSession()
        console.log('session-opened')
        let commands
        try{
          const first=await session.runCommand("shopt -s expand_aliases; alias greet='printf hi-'; value=owner").result
          console.log('first-command')
          const second=await session.runCommand('greet; printf "%s\\n" "$value"').result
          const third=await session.runCommand('printf "new\\n" > answer.txt').result
          const sized=await session.runCommand('stty size',undefined,{columns:67,rows:19}).result
          const file=new TextDecoder().decode(await client.readFile('/project/answer.txt'))
          const interruptedCommand=session.runCommand('sleep 5')
          setTimeout(()=>interruptedCommand.interrupt(),150)
          const interrupted=await interruptedCommand.result
          const resumed=await session.runCommand('greet; printf "%s\\n" "$value"').result
          commands={first,second,third,sized,file,interrupted,resumed}
        }finally{await session.dispose()}
        let staleSessionRejected=false
        try{session.runCommand('pwd')}catch(error){staleSessionRejected=String(error).includes('Terminal session closed')}
        const replacement=await client.openTerminalSession()
        try{
          const fresh=await replacement.runCommand('printf "fresh:%s\\n" "$value"; cat answer.txt').result
          const foreground=replacement.runCommand('sleep 5')
          await new Promise(resolve=>setTimeout(resolve,150))
          await replacement.dispose()
          let foregroundClosed=false
          try{await foreground.result}catch(error){foregroundClosed=String(error).includes('Terminal session closed')}
          const afterClose=await client.openTerminalSession()
          try{
            const recovered=await afterClose.runCommand('cat answer.txt; pwd').result
            return {...commands,invalidSizeRejected,oneShot,staleSessionRejected,fresh,foregroundClosed,recovered}
          }finally{await afterClose.dispose()}
        }finally{await replacement.dispose()}
      }catch(error){console.log('caught',String(error));return {error:String(error),events:events.slice(-12)}}
      finally{await client.dispose();client.close();frame.remove()}
    },owner)
    if(result.error)throw Error(`${name}: ${JSON.stringify(result)}`)
    console.log(name,JSON.stringify({second:result.second.stdout,file:result.file,interrupt:result.interrupted.exitCode,resumed:result.resumed.stdout,fresh:result.fresh.stdout,foregroundClosed:result.foregroundClosed,recovered:result.recovered.stdout}))
    assert.equal(result.first.exitCode,0)
    assert.equal(result.second.stdout,'hi-owner\n')
    assert.equal(result.sized.stdout,'19 67\n')
    assert.equal(result.invalidSizeRejected,true)
    assert.equal(result.oneShot.stdout,'27 93\n')
    assert.equal(result.file,'new\n')
    assert.ok(result.third.changedPaths.includes('/project/answer.txt'))
    assert.equal(result.interrupted.exitCode,130)
    assert.equal(result.resumed.stdout,'hi-owner\n')
    assert.equal(result.staleSessionRejected,true)
    assert.equal(result.fresh.exitCode,0)
    assert.equal(result.fresh.stdout,'fresh:\nnew\n')
    assert.equal(result.foregroundClosed,true)
    assert.equal(result.recovered.exitCode,0)
    assert.equal(result.recovered.stdout,'new\n/project\n')
  }finally{await browser.close()}
}
