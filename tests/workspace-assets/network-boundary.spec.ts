import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true])test(`${guestWasm?'WASM bridge':'default engine'}: workspace URL and socket boundaries deny external destinations`,async({page,context,baseURL},info)=>{
  const escaped:string[]=[]
  const origin=new URL(baseURL!).origin
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){escaped.push(route.request().url());return route.abort()}
    return route.continue()
  })
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async guestWasm=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/data':'workspace only','/probe.mjs':`
      import net from 'node:net';
      const urls=[
        'https://example.invalid/data','https://workspace.invalid.evil.invalid/data',
        'https://workspace.invalid@other.invalid/data','https://user@workspace.invalid/data',
        'https://workspace.invalid:444/data','http://workspace.invalid/data',
        'file://other.invalid/data','http://127.0.0.1:9/data',
        'data:text/plain,external','blob:https://workspace.invalid/fake'
      ];
      const denied=[];
      const constructors=[];
      for(const url of ['https://user@workspace.invalid/data','https://:password@workspace.invalid/data','https://%75ser@workspace.invalid/data']){
        let error='accepted';try{new Request(url)}catch(e){error=e.name}constructors.push(error);
      }
      for(const url of urls){let error='accepted',requestURL;try{requestURL=new Request(url).url;await fetch(url)}catch(e){error=e.name}denied.push({url,requestURL,error})}
      const sockets=[];
      for(const host of ['example.invalid','192.0.2.1','169.254.169.254','::ffff:127.0.0.1']){
        const error=await new Promise(resolve=>{
          try{const socket=net.createConnection({host,port:9});socket.on('error',e=>{socket.destroy();resolve(e.code)});socket.on('connect',()=>{socket.destroy();resolve('connected')})}
          catch(e){resolve(e.code)}
        });sockets.push({host,error});
      }
      const allowed=[];
      for(const url of ['file:///data','https://workspace.invalid/data'])allowed.push(await(await fetch(url)).text());
      console.log(JSON.stringify({denied,constructors,sockets,allowed,ambient:[typeof document,typeof XMLHttpRequest,typeof WebSocket,typeof __readWorkspaceAsset]}));
    `})
    try{const execution=await kernel.runModule('/probe.mjs',{guestWasm,webAPIs:true,workspaceFetch:true,timeoutMs:5000});const url=new URL('file://other.invalid/data');return {...execution,hostFileURL:{href:url.href,host:url.host}}}
    finally{kernel.close()}
  },guestWasm)
  await info.attach('network-boundary.json',{body:JSON.stringify({result,escaped}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const output=JSON.parse(result.stdout)
  expect(output.denied).toHaveLength(10)
  expect(output.constructors).toEqual(['TypeError','TypeError','TypeError'])
  expect(output.denied.every((row:{error:string})=>row.error==='TypeError')).toBe(true)
  expect(output.sockets.map((row:{error:string})=>row.error)).toEqual(['EACCES','EACCES','EACCES','EACCES'])
  expect(output.allowed).toEqual(['workspace only','workspace only'])
  expect(output.ambient).toEqual(['undefined','undefined','undefined','undefined'])
  expect(escaped).toEqual([])
})
