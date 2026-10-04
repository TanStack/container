import assert from 'node:assert/strict'
import {chromium,firefox,webkit} from 'playwright'

const origin=process.env.NATIVE_OWNER_ORIGIN??'http://127.0.0.1:4257'
const site=process.env.NATIVE_SITE_ORIGIN??'http://127.0.0.1:4258'
for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
  const browser=await engine.launch({headless:true})
  try{
    const page=await browser.newPage()
    const ownerFrame=page.waitForEvent('framenavigated',{
      predicate:frame=>frame.url().startsWith(origin+'/owner.html'),timeout:60000,
    })
    await page.goto(site+'/start/latest/docs/framework/react/examples/start-counter?panel=playground')
    const frame=await ownerFrame
    const result=await frame.evaluate(async()=>{
      const {NativeDevServer}=await import('/sdk/index.js')
      const server=new NativeDevServer({
        '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
        '/app/answer.txt':'old',
      },{workerURL:'/runtime/native/engine.js',entry:'/app/index.mjs',serveFetchEntry:true})
      try{
        await server.ready
        const session=await server.openTerminalSession()
        const other=await server.openTerminalSession()
        try{
          const setup=await session.runCommand("shopt -s expand_aliases; alias greet='printf alias-'; local_value=kept; function finish { printf function; }")
          const state=await session.runCommand('greet; finish; printf ":%s\\n" "$local_value"')
          const isolated=await other.runCommand('printf "%s\\n" "$local_value"')
          await session.runCommand('set -o pipefail')
          const pipeline=await session.runCommand('false | true')
          const write=await session.runCommand('printf "new\\n" > answer.txt')
          const file=new TextDecoder().decode(await server.readFile('/app/answer.txt'))
          const controller=new AbortController()
          const started=performance.now()
          const interruptedPromise=session.runCommand('sleep 5',undefined,controller.signal)
          setTimeout(()=>controller.abort(),150)
          const interrupted=await interruptedPromise
          const elapsed=performance.now()-started
          const resumed=await session.runCommand('greet; printf "%s\\n" "$local_value"')
          return {setup,state,isolated,pipeline,write,file,interrupted,elapsed,resumed}
        }finally{await session.dispose();await other.dispose()}
      }catch(error){return {error:String(error),diagnostics:server.diagnostics.slice(-8),progress:server.progress.slice(-8)}}
      finally{await server.close()}
    })
    if(result.error)throw Error(`${name}: ${JSON.stringify(result)}`)
    console.log(name,JSON.stringify({state:result.state.stdout,pipeline:result.pipeline.exitCode,file:result.file,
      interrupt:result.interrupted.exitCode,elapsed:Math.round(result.elapsed),resumed:result.resumed.stdout}))
    assert.equal(result.setup.exitCode,0)
    assert.equal(result.state.stdout,'alias-function:kept\n')
    assert.equal(result.isolated.stdout,'\n')
    assert.equal(result.pipeline.exitCode,1)
    assert.equal(result.write.exitCode,0)
    assert.equal(result.file,'new\n')
    assert.ok(result.write.changedPaths.includes('/app/answer.txt'))
    assert.equal(result.interrupted.exitCode,130)
    assert.ok(result.elapsed<3000)
    assert.equal(result.resumed.stdout,'alias-kept\n')
  }finally{await browser.close()}
}
