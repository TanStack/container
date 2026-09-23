import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve,sep,extname} from 'node:path'
import {spawnSync} from 'node:child_process'

const root=realpathSync(process.env.SDK_OUTPUT)
let server,url
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

const prelude=`const {AsyncLocalStorage}=require('node:async_hooks'),als=new AsyncLocalStorage(),events=[];
const record=name=>events.push(name+':'+als.getStore());
function probe(done){als.run('callback-context',()=>{Promise.resolve().then(()=>{record('promise');process.nextTick(()=>record('promise-tick'))});process.nextTick((arg)=>{record('tick:'+arg);process.nextTick(()=>record('nested-tick'))},42);queueMicrotask(()=>record('microtask'));setImmediate(done)})}
const fail=error=>{console.error(error);process.exitCode=1};`
const cases=[
  {name:'routed MessageChannel message',source:prelude+`const {MessageChannel}=require('node:worker_threads'),channel=new MessageChannel();channel.port1.once('message',value=>{if(value!=='hello')throw Error('payload');probe(()=>{channel.port1.close();channel.port2.close();console.log(JSON.stringify(events))})});channel.port2.postMessage('hello');`},
  {name:'TCP accept',source:prelude+`const net=require('node:net');let client;const server=net.createServer(socket=>probe(()=>{socket.destroy();client.destroy();server.close(()=>console.log(JSON.stringify(events)))}));server.on('error',fail);server.listen(0,'127.0.0.1',()=>{client=net.connect(server.address().port,'127.0.0.1');client.on('error',fail)});`},
  {name:'TCP data',source:prelude+`const net=require('node:net');let client;const server=net.createServer(socket=>{socket.on('error',fail);socket.once('data',data=>{if(data.toString()!=='hello')throw Error('payload');probe(()=>{socket.destroy();client.destroy();server.close(()=>console.log(JSON.stringify(events)))})})});server.on('error',fail);server.listen(0,'127.0.0.1',()=>{client=net.connect(server.address().port,'127.0.0.1',()=>client.write('hello'));client.on('error',fail)});`},
  {name:'UDP message',source:prelude+`const dgram=require('node:dgram'),socket=dgram.createSocket('udp4'),sender=dgram.createSocket('udp4');socket.on('error',fail);sender.on('error',fail);socket.once('message',data=>{if(data.toString()!=='hello')throw Error('payload');probe(()=>{sender.close();socket.close(()=>console.log(JSON.stringify(events)))})});socket.bind(0,'127.0.0.1',()=>sender.send('hello',socket.address().port,'127.0.0.1'));`},
]
for(const sample of cases)test(`nextTick checkpoint in ${sample.name}`,async({page},info)=>{
  test.setTimeout(45000)
  const native=spawnSync(process.execPath,['-e',sample.source],{encoding:'utf8',timeout:10000})
  expect(native.status,native.stderr||native.error?.message).toBe(0)
  const expected=JSON.parse(native.stdout.trim().split('\n').at(-1))
  await page.goto(url);await page.waitForFunction(()=>!!window.sdk)
  const observed=await page.evaluate(async source=>{
    const kernel=new window.sdk.WorkerKernel({'/main.cjs':source},{experimentalFibers:true,maxBytes:64*1024*1024,timeoutMs:10000})
    try{return await kernel.runModule('/main.cjs',{guestWasm:true,webAPIs:true,maxBytes:64*1024*1024,timeoutMs:10000})}finally{kernel.close()}
  },sample.source)
  const path=info.outputPath('callback-next-tick.json');await writeFile(path,JSON.stringify({sdk:root,sample,native:{status:native.status,stdout:native.stdout,stderr:native.stderr,result:expected},observed},null,2));await info.attach('evidence',{path,contentType:'application/json'})
  expect(observed.exitCode,observed.stderr).toBe(0)
  expect(JSON.parse(observed.stdout.trim().split('\n').at(-1))).toEqual(expected)
})
