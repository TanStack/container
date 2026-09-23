import {Workspace} from '../sandbox/workspace'
import {buildStartFixtureInBrowser} from '../start-fixture/browser-build'

export async function runCombinedIO(){
  const w=new Workspace({files:{
    '/value':'before',
    '/main.mjs':`import {AsyncLocalStorage} from 'node:async_hooks';
      import {readFileSync,writeFileSync} from 'node:fs';import {readFile} from 'node:fs/promises';
      const s=new AsyncLocalStorage();console.log('ready');
      const rows=await Promise.all(['a','b','c'].map(id=>s.run(id,async()=>{
        const pending=readFile('/value','utf8');const first=readFileSync('/value','utf8');
        await 0;writeFileSync('/'+id,s.getStore());
        const timer=await new Promise(resolve=>setTimeout(()=>resolve([s.getStore(),readFileSync('/'+id,'utf8')]),1));
        return [id,first,await pending,timer,s.getStore()];
      })));console.log(JSON.stringify({rows,outer:s.getStore()??null}));`,
  }})
  try{
    const execution=await w.executeInVM('/main.mjs',{engine:'quickjs-als-asyncify',timeoutMs:10000,
      onOutput:(_,text)=>{if(text.includes('ready'))w.files.writeFile('/value',new TextEncoder().encode('host-edit'))}})
    const expected={rows:['a','b','c'].map(id=>[id,'host-edit','host-edit',[id,id],id]),outer:null}
    if(execution.exitCode)throw new Error(execution.stderr)
    const actual=JSON.parse(execution.stdout.trim().split('\n').at(-1)!)
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Combined I/O mismatch: '+JSON.stringify(actual))
    return {execution,actual,status:'pass' as const}
  }finally{w.close()}
}

export async function runCombinedStart(onProgress?:(message:string)=>void){
  const build=await buildStartFixtureInBrowser(onProgress,'workerd')
  const w=new Workspace({files:{
    '/start.mjs':build.code,
    '/main.mjs':`import server from './start.mjs';
      const results=await Promise.all(['/', '/about', '/?check=overlap'].map(async path=>{
        const response=await server.fetch(new Request('http://sandbox.local'+path));
        return {path,status:response.status,html:await response.text()};
      }));console.log(JSON.stringify(results));`,
  }})
  try{
    const execution=await w.executeInVM('/main.mjs',{engine:'quickjs-als-asyncify',webAPIs:true,maxBytes:64*1024*1024,timeoutMs:30000})
    if(execution.exitCode)throw new Error(execution.stderr)
    const responses=JSON.parse(execution.stdout) as Array<{path:string;status:number;html:string}>
    for(const row of responses){
      const heading=row.path==='/about'?'Second route':'Bare-bones Start'
      if(row.status!==200||!row.html.includes(heading)||!row.html.endsWith('</html>'))
        throw new Error(`Start response failed for ${row.path}: ${row.status}, ${row.html.slice(0,200)}`)
    }
    return {status:'pass' as const,execution,responses,packages:build.packageCount,bytes:build.code.length,
      exportConditions:['workerd'],nativeAwait:true}
  }finally{w.close()}
}
