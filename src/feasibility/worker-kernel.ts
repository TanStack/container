import {WorkerKernel} from '../sandbox/kernel'
import {buildStartFixtureInBrowser} from '../start-fixture/browser-build'
import cases from './als-cases.json'
import rawCases from './als-cases.json?raw'

export async function runWorkerKernel(onProgress:(message:string)=>void=()=>{}){
  const response=await fetch('/quickjs-als/reference.json',{cache:'no-store'})
  if(!response.ok)throw Error('Missing ALS reference')
  const reference=await response.json()
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(rawCases))),x=>x.toString(16).padStart(2,'0')).join('')
  if(reference.corpusSHA256!==digest||reference.results.length!==cases.length)throw Error('Stale ALS reference')
  const kernel=new WorkerKernel({'/value':'before'})
  try{
    const als=[]
    for(const fixture of cases){
      const expected=reference.results.find((r:{id:string})=>r.id===fixture.id)?.expected
      const actual=await kernel.execute(`const ALS=__webContainerHost.AsyncLocalStorage;
        console.log(JSON.stringify(await(async()=>{${fixture.code}})()));`)
      if(actual.exitCode||actual.stdout.trim()!==expected)throw Error(fixture.id+': '+JSON.stringify(actual))
      als.push({id:fixture.id,expected,actual})
    }
    onProgress(`${als.length}/${cases.length} native ALS cases matched Node`)
    await kernel.writeText('/io.mjs',`import {AsyncLocalStorage} from 'node:async_hooks';
      import {readFileSync,writeFileSync} from 'node:fs';import {readFile} from 'node:fs/promises';
      const s=new AsyncLocalStorage();console.log('ready');
      const rows=await Promise.all(['a','b','c'].map(id=>s.run(id,async()=>{
        while(readFileSync('/value','utf8')!=='host-edit')await new Promise(r=>setTimeout(r,1));
        await 0;writeFileSync('/'+id,s.getStore());
        return [id,await readFile('/value','utf8'),readFileSync('/'+id,'utf8'),s.getStore()];
      })));console.log(JSON.stringify(rows));`)
    let edit:Promise<void>|undefined
    const io=await kernel.run('/io.mjs',{onOutput:(_,text)=>{
      if(text.includes('ready'))edit=kernel.writeText('/value','host-edit')
    }})
    await edit
    if(io.exitCode)throw Error(io.stderr)
    const rows=JSON.parse(io.stdout.trim().split('\n').at(-1)!)
    if(JSON.stringify(rows)!==JSON.stringify(['a','b','c'].map(id=>[id,'host-edit',id,id])))throw Error('Live filesystem mismatch')
    for(const id of ['a','b','c'])if(await kernel.readText('/'+id)!==id)throw Error('Guest write not visible to agent')
    onProgress('Live sync/async files and agent edits passed')
    const build=await buildStartFixtureInBrowser(onProgress,'workerd')
    await kernel.writeText('/start.mjs',build.code)
    await kernel.writeText('/main.mjs',`import server from './start.mjs';
      console.log(JSON.stringify(await Promise.all(['/', '/about', '/?check=overlap'].map(async path=>{
        const response=await server.fetch(new Request('http://sandbox.local'+path));
        return {path,status:response.status,html:await response.text()};
      }))));`)
    const starts=[]
    for(let i=0;i<3;i++){
      const execution=await kernel.run('/main.mjs',{webAPIs:true,maxBytes:64*1024*1024,timeoutMs:30000})
      if(execution.exitCode)throw Error(execution.stderr)
      const responses=JSON.parse(execution.stdout)
      if(responses.length!==3)throw Error('Missing Start responses')
      for(const row of responses)if(row.status!==200||!row.html.endsWith('</html>')||!row.html.includes(row.path==='/about'?'Second route':'Bare-bones Start'))throw Error('Incomplete Start response')
      starts.push({execution,responses})
      onProgress(`Start execution ${i+1}/3 passed`)
    }
    return {generatedAt:new Date().toISOString(),userAgent:navigator.userAgent,engine:'quickjs-als',
      asyncify:false,filesystemOwner:'worker',node:reference.node,corpusSHA256:digest,als,io,starts}
  }finally{kernel.close()}
}
