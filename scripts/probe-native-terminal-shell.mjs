import {chromium,firefox,webkit} from 'playwright'

for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
const browser=await engine.launch({headless:true})
try{
  const page=await browser.newPage()
  const ownerFrame=page.waitForEvent('framenavigated',{predicate:frame=>frame.url().startsWith('http://127.0.0.1:4197/owner.html'),timeout:30000})
  await page.goto('http://127.0.0.1:4198/start/latest/docs/framework/react/examples/start-counter?panel=sandbox')
  const frame=await ownerFrame
  const result=await frame.evaluate(async()=>{
    const {NativeDevServer}=await import('/sdk/index.js')
    const server=new NativeDevServer({
      '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
      '/app/answer.txt':'old',
      '/app/sub/.keep':'',
    },{workerURL:'/runtime/native/engine.js',entry:'/app/index.mjs',serveFetchEntry:true})
    try{
      try{
        await server.ready
        const command=await server.terminalCommand('printf "new\\n" > answer.txt && read value < answer.txt && printf "%s\\n" "$value"')
        const fileCommand=await server.terminalCommand('cat answer.txt')
        const pipeline=await server.terminalCommand('printf "pipeline\\n" | cat')
        const directory=await server.terminalCommand('cd sub && pwd')
        const chunks=[]
        let sawFirst
        const first=new Promise(resolve=>{sawFirst=resolve})
        let settled=false
        const running=server.terminalCommand('printf "first\\n"; sleep 0.5; printf "second\\n"','/app',text=>{
          chunks.push(text)
          if(text.includes('first'))sawFirst()
        }).then(value=>{settled=true;return value})
        await Promise.race([first,new Promise((_,reject)=>setTimeout(()=>reject(Error('No early shell output')),20000))])
        const outputArrivedBeforeExit=!settled
        const streamed=await running
        const controller=new AbortController()
        const interruptedAt=performance.now()
        const interruptedRun=server.terminalCommand('sleep 10','/app',()=>{},controller.signal)
        setTimeout(()=>controller.abort(),100)
        const interrupted=await interruptedRun
        const interruptElapsedMs=Math.round(performance.now()-interruptedAt)
        const afterInterrupt=await server.terminalCommand('pwd')
        const inputChannel=new MessageChannel()
        const inputRun=server.terminalCommand('cat','/app',undefined,undefined,inputChannel.port2)
        inputChannel.port1.postMessage({type:'data',bytes:new TextEncoder().encode('live input\n')})
        inputChannel.port1.postMessage({type:'end'})
        const stdinResult=await inputRun
        inputChannel.port1.close()
        const file=new TextDecoder().decode(await server.readFile('/app/answer.txt'))
        return {command,fileCommand,pipeline,directory,streamed,chunks,outputArrivedBeforeExit,interrupted,interruptElapsedMs,afterInterrupt,stdinResult,file}
      }catch(error){return {error:String(error),diagnostics:server.diagnostics,events:server.events.slice(-10)}}
    }finally{await server.close()}
  })
  console.log(name,JSON.stringify(result))
  if('error' in result)throw Error(result.error)
  if(result.command.exitCode!==0||result.command.stdout!=='new\n'||result.file!=='new\n'||!result.command.changedPaths.includes('/app/answer.txt'))
    throw Error('Native shell did not read and write the live workspace')
  if(result.fileCommand.exitCode!==0||result.fileCommand.stdout!=='new\n')throw Error('Native shell cat did not read the live workspace')
  if(result.pipeline.exitCode!==0||result.pipeline.stdout!=='pipeline\n')throw Error('Native shell pipeline stdin failed')
  if(result.directory.exitCode!==0||result.directory.cwd!=='/app/sub'||result.directory.stdout!=='/project/sub\n')throw Error('Native shell did not report the final working directory')
  if(result.streamed.exitCode!==0||result.streamed.stdout!==''||result.chunks.join('')!=='first\nsecond\n'||!result.outputArrivedBeforeExit)
    throw Error('Native shell output did not arrive before the command exited')
  if(result.interrupted.exitCode!==130||result.interruptElapsedMs>5000||result.afterInterrupt.stdout!=='/project\n')
    throw Error('Native shell interruption did not stop the command and preserve the dev server')
  if(result.stdinResult.exitCode!==0||result.stdinResult.stdout!=='live input\n')throw Error('Native shell did not receive live stdin')
}finally{await browser.close()}
}
