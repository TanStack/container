import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {guestTLSCases} from '../../fixtures/guest-tls-cases.mjs'
const identity=JSON.parse(readFileSync('public/tls-probe/build.json','utf8'))
const prelude=Object.entries({ca:'ca.pem',cert:'server.pem',key:'server-key.pem',wrongKey:'ca-key.pem'}).map(([name,file])=>`const ${name}=${JSON.stringify(readFileSync(identity.directory+'/'+file,'utf8'))};`).join('\n')
for(const guestWasm of [false,true])for(const [name,body] of Object.entries(guestTLSCases))test(`${guestWasm?'WASM bridge':'default engine'}: ${name}`,async({page},info)=>{
  const source=prelude+'\n'+body
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const trace=process.env.TLS_TRACE?`import {TLSSocket as TraceSocket} from 'node:tls';
    const traceCall=globalThis.__webContainerHost.tls.call;
    globalThis.__webContainerHost.tls.call=function(method,...args){const result=traceCall(method,...args);if(method==='read'||method==='write')console.error('tls-io',method,args[0],typeof result==='object'?result.code:result);return result};
    const traceEmit=TraceSocket.prototype.emit;
    TraceSocket.prototype.emit=function(event,...args){console.error('tls-event',this._server?'server':'client',event);return traceEmit.call(this,event,...args)};
    const tracePump=TraceSocket.prototype._pump;
    TraceSocket.prototype._pump=function(){const before=[this._secure,this._input.length,this._writingCiphertext,this._closing,this._receivedEnd];try{return tracePump.call(this)}finally{console.error('tls-pump',this._server?'server':'client',JSON.stringify(before),JSON.stringify([this._plainWanted,this._applicationWrite?.offset,this._socket.isPaused(),this._socket.readableLength,this._socket.writableLength,this._input.length]))}};
  `:''
  const result=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,maxBytes:32*1024*1024,timeoutMs:15000})}finally{kernel.close()}
  },{source:trace+source,guestWasm})
  if(trace)console.log(JSON.stringify(result))
  await info.attach('guest-tls.json',{body:JSON.stringify({node:node.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(node.stdout)
})

for(const guestWasm of [false,true])for(const cancelled of [false,true])test(`${guestWasm?'WASM bridge':'default engine'}: repeated TLS ${cancelled?'cancellation':'normal exit'} releases process owners`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async({prelude,guestWasm,cancelled})=>{
    const source=prelude+`\nimport tls from 'node:tls';\n`+(cancelled?
      `const server=tls.createServer({cert,key});server.listen(8497,()=>console.log('ready'));`:
      `tls.createSecureContext({cert,key,ca});console.log('done');`)
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    const results=[]
    try{
      // The backend permits four simultaneous owners. Six sequential runs must
      // succeed in one kernel, without relying on worker disposal for cleanup.
      for(let cycle=0;cycle<6;cycle++){
        if(!cancelled){results.push(await kernel.runModule('/main.mjs',{guestWasm,maxBytes:32*1024*1024}));continue}
        const child=await kernel.spawn('node',['/main.mjs'],{guestWasm,lifetime:'session',maxBytes:32*1024*1024})
        const ready=await child.next()
        const peer=await kernel.connect(8497)
        try{
          // A partial TLS record leaves a live handshake waiting for more input.
          await peer.write(new Uint8Array([22,3,3,0,10,1]))
          await child.kill()
          results.push({ready,stopped:await child.wait()})
        }finally{await peer.close();await child.dispose()}
      }
      return results
    }finally{kernel.close()}
  },{prelude,guestWasm,cancelled})
  await info.attach('tls-process-cleanup.json',{body:JSON.stringify(results),contentType:'application/json'})
  expect(results).toHaveLength(6)
  for(const result of results){
    if('stopped' in result){expect(cancelled).toBe(true);expect(result.ready?.type).toBe('stdout');expect(result.stopped.signal).toBe('SIGTERM')}
    else{expect(cancelled).toBe(false);expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe('done\n')}
  }
})
