import {test,expect} from '@playwright/test'
import {createServer,type Server} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'

const root=realpathSync(process.env.SDK_OUTPUT!)
let server:Server,url:string
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname
    if(path==='/app/'){res.setHeader('Content-Type','text/html');res.end('<script type="module">import * as sdk from "./vendor/index.js";window.sdk=sdk</script>');return}
    try{
      if(!path.startsWith('/app/vendor/'))throw Error('Outside SDK')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice('/app/vendor/'.length))))
      if(!file.startsWith(root+sep))throw Error('Outside SDK')
      res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.writeHead(404);res.end()}
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  url=`http://127.0.0.1:${(server.address() as {port:number}).port}/app/`
})
test.afterAll(async()=>{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))})
const node=(source:string)=>'node -e '+"'"+source.replaceAll("'","'\\''")+"'"
const args=node('console.log(JSON.stringify(process.argv.slice(1)))')
const cat=node('const fs=require("node:fs");if(process.argv[1])process.stdout.write(fs.readFileSync(process.argv[1]));else process.stdin.pipe(process.stdout)')
const fail=node('console.error("failure");process.exit(7)')
const many=node('let remaining=4194304;function write(){while(remaining){const size=Math.min(16384,remaining);remaining-=size;if(!process.stdout.write(Buffer.alloc(size,65))){process.stdout.once("drain",write);return}}}write()')
const rows=[
  {name:'shared filesystem and redirects',script:node('const fs=require("node:fs");fs.writeFileSync("from-worker.txt","live");process.stdout.write(fs.readFileSync("input.txt"))')+' > output.txt; '+cat+' from-worker.txt; '+cat+' output.txt',stdout:'liveshared data'},
  {name:'cwd env quoting',script:'DEMO=value '+node('console.log(JSON.stringify({cwd:process.cwd(),env:process.env.DEMO}))')+'; '+args+' "a b" ""',stdout:'{"cwd":"/project","env":"value"}\n["a b",""]\n'},
  {name:'live pipeline handshake',script:node('const fs=require("node:fs");process.stdout.write("first\\n");const t=setInterval(()=>{if(fs.existsSync("ack")){clearInterval(t);fs.writeFileSync("producer-ended","yes")}},10)')+' | '+node('const fs=require("node:fs");process.stdin.on("data",chunk=>{if(fs.existsSync("producer-ended"))throw Error("producer ended before consume");fs.writeFileSync("ack","yes");process.stdout.write(chunk)})'),stdout:'first\n'},
  {name:'4MiB streaming',script:many+' | '+node('let n=0;process.stdin.on("data",chunk=>{for(const byte of chunk)if(byte!==65)throw Error("bad byte");n+=chunk.length});process.stdin.on("end",()=>process.stdout.write(String(n)))'),stdout:'4194304'},
  {name:'binary pipeline',script:node('process.stdout.write(Buffer.from([0,255,128,65,10]))')+' | '+cat,bytes:[0,255,128,65,10]},
  {name:'stderr and exit propagation',script:fail+' && echo bad || echo recovered',stdout:'recovered\n',stderr:'failure\n'},
  {name:'PATH and shebang dispatch',script:'demo "package script"',stdout:'["package script"]\n'},
  {name:'missing executable',script:'not-installed',code:127},
  {name:'functions loops substitutions',script:'f() { for x in a b; do echo "$x"; done; }; '+args+' "$(f)"',stdout:'["a\\nb"]\n'},
  {name:'cwd change and glob',script:'cd /project/node_modules/.bin; '+args+' d*',stdout:'["demo"]\n'},
  {name:'append redirect',script:'echo one > append.txt; echo two >> append.txt; '+cat+' append.txt',stdout:'one\ntwo\n'},
  {name:'subshell state isolation',script:'(cd /project/node_modules); pwd',stdout:'/project\n'},
  {name:'pipefail',script:'set -o pipefail; '+fail+' | '+cat,code:7,stdout:'',stderr:'failure\n'},
  {name:'errexit',script:'set -e; '+fail+'; echo bad',code:7,stdout:'',stderr:'failure\n'},
  {name:'early pipeline consumer exit',script:many+' | echo done',stdout:'done\n'},
  {name:'background wait',script:args+' background & wait',stdout:'["background"]\n'},
]

test('packaged project commands honor pnpm scripts and keep the declared server alive',async({page},info)=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const actual=await page.evaluate(async()=>{
    const {WorkerKernel,spawnProjectCommand}=(window as any).sdk
    const files={
      '/project/package.json':JSON.stringify({name:'command-fixture',version:'1.0.0',scripts:{predev:'node prepare.mjs',dev:'node server.mjs'}}),
      '/project/prepare.mjs':`import {writeFileSync} from 'node:fs';writeFileSync('prepared',process.env.npm_lifecycle_event)`,
      '/project/server.mjs':`import {readFileSync} from 'node:fs';console.log(JSON.stringify({event:process.env.npm_lifecycle_event,name:process.env.npm_package_name,prepared:readFileSync('prepared','utf8')}));setInterval(()=>{},1000)`,
    }
    const kernel=new WorkerKernel(files),child=await spawnProjectCommand(kernel,'pnpm run dev',{cwd:'/project',writable:true,lifetime:'session',timeoutMs:10000})
    try{
      let stdout=''
      const deadline=performance.now()+10000
      while(performance.now()<deadline&&!stdout.includes('\n')){
        const event=await child.next()
        if(event?.type==='stdout')stdout+=new TextDecoder().decode(event.bytes)
        if(event?.type==='exit')break
      }
      return {stdout,prepared:await kernel.readText('/project/prepared'),running:(await kernel.resources()).processes.active}
    }finally{await child.dispose();kernel.close()}
  })
  await info.attach('project-command.json',{body:JSON.stringify(actual),contentType:'application/json'})
  expect(actual).toEqual({stdout:'{"event":"dev","name":"command-fixture","prepared":"predev"}\n',prepared:'predev',running:1})
})

for(const row of rows)test('packaged shell: '+row.name,async({page},info)=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const actual=await page.evaluate(async script=>{
    const {WorkerKernel,runShell}=(window as any).sdk
    const kernel=new WorkerKernel({'/project/input.txt':'shared data','/project/node_modules/.bin/demo':'#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))'})
    try{
      const result=await runShell(kernel,script,{writable:true,timeoutMs:30000})
      return {code:result.exitCode,stdout:new TextDecoder().decode(result.stdout),stderr:new TextDecoder().decode(result.stderr),bytes:[...result.stdout]}
    }finally{kernel.close()}
  },row.script)
  await info.attach('shell-case.json',{body:JSON.stringify({row,actual}),contentType:'application/json'})
  expect(actual.code).toBe(row.code??0)
  if('stdout'in row)expect(actual.stdout).toBe(row.stdout)
  if('bytes'in row)expect(actual.bytes).toEqual(row.bytes)
  if(row.name!=='missing executable')expect(actual.stderr).toBe(row.stderr??'')
})

test('packaged shell: pipeline cancellation preserves files and permits restart',async({page},info)=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const actual=await page.evaluate(async()=>{
    const {WorkerKernel,runShell}=(window as any).sdk
    const kernel=new WorkerKernel({'/project/input.txt':'kept'})
    try{
      const error=await runShell(kernel,`printf saved > saved.txt; node -e 'setInterval(()=>{},1000)' | node -e 'process.stdin.resume();setInterval(()=>{},1000)'`,{writable:true,timeoutMs:3000}).then(()=>'',(error:unknown)=>String(error))
      const saved=await kernel.readText('/project/saved.txt')
      const next=await runShell(kernel,'printf restarted',{timeoutMs:10000})
      return {error,saved,code:next.exitCode,stdout:new TextDecoder().decode(next.stdout)}
    }finally{kernel.close()}
  })
  await info.attach('shell-cancellation.json',{body:JSON.stringify(actual),contentType:'application/json'})
  expect(actual.error).toContain('timed out');expect(actual.saved).toBe('saved');expect(actual.code).toBe(0);expect(actual.stdout).toBe('restarted')
})

test('packaged shell: nested guest shell execution reports its unsupported API',async({page},info)=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const actual=await page.evaluate(async()=>{
    const {WorkerKernel,runMvdanShell}=(window as any).sdk,kernel=new WorkerKernel({'/project/input':''})
    try{
      const result=await runMvdanShell(kernel,`node -e 'try{require("node:child_process").execSync("echo nested")}catch(error){console.log(error.code)}'`,{timeoutMs:10000})
      return {code:result.code,stdout:new TextDecoder().decode(result.stdout)}
    }finally{kernel.close()}
  })
  await info.attach('nested-shell-support.json',{body:JSON.stringify(actual),contentType:'application/json'})
  expect(actual).toEqual({code:0,stdout:'ERR_UNSUPPORTED_OPERATION\n'})
})

test('runShell reports a rejected process allocation on stderr',async({page})=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const result=await page.evaluate(async()=>{
    const {WorkerKernel,runShell}=(window as any).sdk
    const kernel=new WorkerKernel({'/project/package.json':'{}'}, {maxBytes:256*1024*1024})
    const children=[]
    try{
      for(let index=0;index<2;index++)children.push(await kernel.spawn('node',['-e','setInterval(()=>{},1000)'],{maxBytes:256*1024*1024,lifetime:'session'}))
      const rejected=await runShell(kernel,'node -e "console.log(1)"',{timeoutMs:10000})
      return {exitCode:rejected.exitCode,stdout:new TextDecoder().decode(rejected.stdout),stderr:new TextDecoder().decode(rejected.stderr)}
    }finally{await Promise.all(children.map(child=>child.dispose()));kernel.close()}
  })
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('Aggregate process memory reservations exceed 512 MiB')
  expect(result.stderr).toContain('requestedBytes=16777216')
})

test('runShell carries cwd, env and binary stdin without leaking options to the next shell',async({page},info)=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const actual=await page.evaluate(async()=>{
    const {WorkerKernel,runShell,runMvdanShell}=(window as any).sdk
    const kernel=new WorkerKernel({'/project/input':'root','/workspace/input':'local'})
    const decode=(value:any)=>({exitCode:value.exitCode,stdout:new TextDecoder().decode(value.stdout),stderr:new TextDecoder().decode(value.stderr)})
    try{
      const settings=decode(await runShell(kernel,`printf '%s|%s|' "$PWD" "$GREETING"; node -e 'console.log(JSON.stringify([process.cwd(),process.env.GREETING,require("node:fs").readFileSync("input","utf8")]))'`,{cwd:'/workspace',env:{GREETING:'hello world'},timeoutMs:10000}))
      const binary=await runShell(kernel,`node -e 'process.stdin.pipe(process.stdout)'`,{cwd:'/workspace',stdin:new Uint8Array([0,255,128,65,10]),timeoutMs:10000})
      const read=decode(await runShell(kernel,`read first; read second; printf '%s|%s' "$first" "$second"`,{stdin:new TextEncoder().encode('one\ntwo\n'),timeoutMs:10000}))
      const next=decode(await runShell(kernel,'printf "%s|%s" "$PWD" "${GREETING-unset}"',{timeoutMs:10000}))
      const legacy=await runMvdanShell(kernel,'printf legacy',{timeoutMs:10000})
      return {settings,binary:{exitCode:binary.exitCode,bytes:[...binary.stdout]},read,next,legacy:{code:legacy.code,error:legacy.error,stdout:new TextDecoder().decode(legacy.stdout)}}
    }finally{kernel.close()}
  })
  await info.attach('shell-options.json',{body:JSON.stringify(actual),contentType:'application/json'})
  expect(actual.settings).toEqual({exitCode:0,stdout:'/workspace|hello world|["/workspace","hello world","local"]\n',stderr:''})
  expect(actual.binary).toEqual({exitCode:0,bytes:[0,255,128,65,10]})
  expect(actual.read).toEqual({exitCode:0,stdout:'one|two',stderr:''})
  expect(actual.next).toEqual({exitCode:0,stdout:'/project|unset',stderr:''})
  expect(actual.legacy).toEqual({code:0,error:'',stdout:'legacy'})
})

test('runShell AbortSignal stops a guest timer and permits an immediate restart',async({page},info)=>{
  await page.goto(url);await page.waitForFunction(()=>Boolean((window as any).sdk))
  const actual=await page.evaluate(async()=>{
    const {WorkerKernel,runShell}=(window as any).sdk
    const kernel=new WorkerKernel({'/project/input':'kept'})
    const controller=new AbortController()
    let outcome:Promise<any>|undefined
    try{
      outcome=runShell(kernel,`node -e 'require("node:fs").writeFileSync("/project/started","yes");setInterval(()=>{},1000)'`,{writable:true,timeoutMs:15000,signal:controller.signal})
        .then((result:any)=>({unexpectedExit:result.exitCode}),(error:any)=>({name:error?.name,message:String(error?.message)}))
      // Abort only after the actual guest has started and written its marker.
      const deadline=performance.now()+10000
      let started=''
      while(performance.now()<deadline){
        try{started=await kernel.readText('/project/started')}catch{}
        if(started==='yes')break
        await new Promise(resolve=>setTimeout(resolve,25))
      }
      if(started!=='yes')throw Error('Guest timer did not start before cancellation check')
      controller.abort()
      const aborted=await outcome
      const retained=await kernel.readText('/project/started')
      const restart=await runShell(kernel,'printf restarted',{timeoutMs:10000})
      return {aborted,retained,restart:{exitCode:restart.exitCode,stdout:new TextDecoder().decode(restart.stdout),stderr:new TextDecoder().decode(restart.stderr)}}
    }finally{controller.abort();await outcome;kernel.close()}
  })
  await info.attach('shell-abort.json',{body:JSON.stringify(actual),contentType:'application/json'})
  expect(actual.aborted.name).toBe('AbortError')
  expect(actual.retained).toBe('yes')
  expect(actual.restart).toEqual({exitCode:0,stdout:'restarted',stderr:''})
})
