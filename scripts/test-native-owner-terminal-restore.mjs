import assert from 'node:assert/strict'
import {chromium,firefox,webkit} from 'playwright'

const site=process.env.NATIVE_SITE_ORIGIN??'http://127.0.0.1:4348'
const owner=process.env.NATIVE_OWNER_ORIGIN??'http://127.0.0.1:4347'

for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
  if(process.env.NATIVE_BROWSER&&process.env.NATIVE_BROWSER!==name)continue
  const browser=await engine.launch({headless:true})
  try{
    const page=await browser.newPage()
    await page.goto(site+'/')
    const result=await page.evaluate(async ownerOrigin=>{
      const {NativeOwnerClient}=await import('/sdk/index.js')
      async function connect(){
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
        return {frame,client}
      }
      const options={workspaceRoot:'/project',entry:'/project/index.mjs',serveFetchEntry:true,installDependencies:false}
      const checkpointKey='terminal-restore-'+crypto.randomUUID()
      const first=await connect()
      let saved
      try{
        await first.client.start({
          '/project/index.mjs':'export default {fetch(){return new Response("ready")}}',
          '/project/answer.txt':'old',
        },options)
        const session=await first.client.openTerminalSession()
        try{
          const edit=await session.runCommand('PERSISTENT_SHELL_ONLY=old; printf "new\\n" > answer.txt').result
          saved={edit,checkpoint:await first.client.saveCheckpoint(checkpointKey)}
        }finally{await session.dispose()}
      }finally{await first.client.dispose();first.client.close();first.frame.remove()}
      const second=await connect()
      try{
        await second.client.restoreCheckpoint(checkpointKey,options)
        const file=new TextDecoder().decode(await second.client.readFile('/project/answer.txt'))
        const session=await second.client.openTerminalSession()
        try{
          const command=await session.runCommand('printf "shell:%s\\n" "$PERSISTENT_SHELL_ONLY"; cat answer.txt; pwd').result
          return {saved,file,command}
        }finally{await session.dispose()}
      }finally{await second.client.dispose();second.client.close();second.frame.remove()}
    },owner)
    assert.equal(result.saved.edit.exitCode,0)
    assert.ok(result.saved.edit.changedPaths.includes('/project/answer.txt'))
    assert.ok(result.saved.checkpoint.files>=2)
    assert.equal(result.file,'new\n')
    assert.equal(result.command.exitCode,0)
    assert.equal(result.command.stdout,'shell:\nnew\n/project\n')
    console.log(`${name}: terminal file restored across owner disposal, fresh shell opened`)
  }finally{await browser.close()}
}
