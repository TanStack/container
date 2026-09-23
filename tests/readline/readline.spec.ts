import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'split UTF-8, CRLF, blank lines and unterminated final line':`
    import {PassThrough} from 'node:stream';import {createInterface} from 'node:readline';import {Buffer} from 'node:buffer';
    const input=new PassThrough(),rl=createInterface({input,crlfDelay:Infinity}),lines=[];
    const done=new Promise(resolve=>rl.on('close',resolve));rl.on('line',line=>lines.push(line));
    for(const byte of Buffer.from('🦊\\r\\nalpha\\rbeta\\n\\ntail'))input.write(Buffer.from([byte]));input.end();
    await done;console.log(JSON.stringify([lines,input.listenerCount('data'),input.listenerCount('end')]));`,
  'questions, prompts and pause resume':`
    import {PassThrough} from 'node:stream';import {createInterface} from 'node:readline';
    const input=new PassThrough(),output=new PassThrough(),rl=createInterface({input,output}),events=[],printed=[];
    output.on('data',value=>printed.push(value.toString()));rl.on('pause',()=>events.push('pause'));rl.on('resume',()=>events.push('resume'));rl.on('line',line=>events.push(line));
    rl.setPrompt('ready> ');rl.prompt();rl.pause();rl.pause();rl.resume();
    rl.question('name? ',answer=>events.push(['answer',answer,rl.getPrompt()]));input.write('Ada\\nextra\\n');rl.close();rl.close();
    console.log(JSON.stringify([events,printed,rl.closed]));`,
  'promise question abort and recovery':`
    import {PassThrough} from 'node:stream';import {createInterface} from 'node:readline/promises';
    const input=new PassThrough(),rl=createInterface({input}),controller=new AbortController();
    const first=rl.question('first',{signal:controller.signal}).catch(error=>[error.name,error.code]);controller.abort();
    const rejected=await first;const second=rl.question('second');input.write('42\\n');const answer=await second;rl.close();
    const closed=await rl.question('closed').catch(error=>error.code);console.log(JSON.stringify([rejected,answer,closed]));`,
  'async iteration and early return leave the interface open':`
    import {PassThrough} from 'node:stream';import {createInterface} from 'node:readline';
    const input=new PassThrough(),rl=createInterface({input}),seen=[];
    const iter=rl[Symbol.asyncIterator]();input.end('one\\ntwo\\nlast');for await(const line of iter)seen.push(line);
    const input2=new PassThrough(),rl2=createInterface({input:input2});const iter2=rl2[Symbol.asyncIterator]();input2.write('stop\\n');
    for await(const line of iter2){seen.push(line);break}console.log(JSON.stringify([seen,rl2.closed,input2.listenerCount('data')]));rl2.close();`,
  'async iterator reports input errors':`
    import {PassThrough} from 'node:stream';import {createInterface} from 'node:readline';
    const input=new PassThrough(),rl=createInterface({input}),iterator=rl[Symbol.asyncIterator]();
    const pending=iterator.next().catch(error=>error.message);input.emit('error',Error('broken'));console.log(JSON.stringify([await pending,await iterator.next()]));rl.close();`,
  'cursor output and callback backpressure':`
    import {cursorTo,moveCursor,clearLine,clearScreenDown} from 'node:readline';
    const out=[],stream={write(text,cb){out.push(text);cb?.();return false}},returns=[];
    returns.push(cursorTo(stream,2),cursorTo(stream,2,3),moveCursor(stream,-2,3),clearLine(stream,-1),clearLine(stream,0),clearLine(stream,1),clearScreenDown(stream));
    await new Promise(resolve=>cursorTo(null,0,()=>{out.push('done');resolve()}));
    console.log(JSON.stringify([out,returns,moveCursor(null,0,0)]));`,
  'input errors, abort signal and question after close':`
    import {PassThrough} from 'node:stream';import {createInterface} from 'node:readline';
    const input=new PassThrough(),controller=new AbortController(),rl=createInterface({input,signal:controller.signal}),seen=[];
    rl.on('error',error=>seen.push(error.message));input.emit('error',Error('input failure'));controller.abort();
    try{rl.question('closed',()=>{})}catch(error){seen.push(error.code)}
    console.log(JSON.stringify([seen,rl.closed,input.listenerCount('data')]));`,
  'promise question preserves asynchronous local context':`
    import {PassThrough} from 'node:stream';import {createInterface} from 'node:readline/promises';import {AsyncLocalStorage} from 'node:async_hooks';
    const input=new PassThrough(),rl=createInterface({input}),als=new AsyncLocalStorage();
    const result=als.run('question',async()=>{const answer=await rl.question('value');return [answer,als.getStore()]});
    als.run('writer',()=>input.write('42\\n'));console.log(JSON.stringify([await result,als.getStore()]));rl.close();`,
}
for(const guestWasm of [false,true])for(const [name,source] of Object.entries(cases))test(`${name} | guest WASM ${guestWasm}`,async({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':source})
    try{return await kernel.runModule('/entry.mjs',{guestWasm,webAPIs:true})}finally{kernel.close()}
  },{source,guestWasm})
  await info.attach('readline.json',{body:JSON.stringify({nodeVersion:process.version,node:node.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(node.stdout)
})
