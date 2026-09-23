import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'

const artifact=JSON.parse(readFileSync('public/kernel-runtime/builtins.json','utf8'))
const cases={
  'modern events helpers cover abort rejection monitoring and async iteration':`
    import events,{EventEmitter,addAbortListener,captureRejectionSymbol,errorMonitor,getEventListeners,getMaxListeners,setMaxListeners,on} from 'node:events';
    const emitter=new EventEmitter({captureRejections:true}),seen=[];emitter.on(errorMonitor,error=>seen.push('monitor:'+error.message));emitter.on('error',error=>seen.push('error:'+error.message));emitter.on('work',async()=>{throw Error('failed')});emitter.emit('work');await new Promise(resolve=>setTimeout(resolve,0));const fn=()=>{},other=new EventEmitter();other.on('x',fn);setMaxListeners(3,other);const iterator=on(other,'data',{close:['close']});other.emit('data',1,2);const item=await iterator.next();other.emit('close');const done=await iterator.next();const controller=new AbortController(),abort=[];addAbortListener(controller.signal,()=>abort.push('yes'));controller.abort();await Promise.resolve();console.log(JSON.stringify({identities:[events.captureRejectionSymbol===captureRejectionSymbol,events.errorMonitor===errorMonitor],seen,listeners:getEventListeners(other,'x').length,max:getMaxListeners(other),item,done,abort}));`,
  'buffer validation constructors constants and supported transcoding':`
    import bufferModule,{Buffer,Blob,File,constants,isAscii,isUtf8,kMaxLength,kStringMaxLength,transcode,resolveObjectURL} from 'node:buffer';
    const values=[new Uint8Array(),new Uint8Array([0,127]),new Uint8Array([128]),new Uint8Array([240,159,166,138]),new Uint8Array([195,40]),new ArrayBuffer(2)],checks=values.map(value=>[isAscii(value),isUtf8(value)]),converted=[...transcode(Buffer.from([104,233]),'latin1','utf8')],repaired=[...transcode(Buffer.from([195,40]),'utf8','utf8')];let unsupported;try{transcode(Buffer.from('x'),'hex','utf8')}catch(error){unsupported=error.code}const blob=new Blob(['hi'],{type:'text/plain'}),file=new File(['ok'],'probe.txt',{type:'text/plain'}),url=URL.createObjectURL(blob),resolved=resolveObjectURL(url),objectURL=[url.startsWith('blob:nodedata:'),resolved!==blob,await resolved.text(),resolved.type];URL.revokeObjectURL(url);objectURL.push(resolveObjectURL(url)===undefined);console.log(JSON.stringify({checks,converted,repaired,unsupported,identities:[bufferModule.Blob===Blob,bufferModule.File===File,bufferModule.constants===constants,bufferModule.transcode===transcode,bufferModule.resolveObjectURL===resolveObjectURL],constants:[constants.MAX_LENGTH===kMaxLength,constants.MAX_STRING_LENGTH===kStringMaxLength,kStringMaxLength],blob:[blob.size,blob.type],file:[file.name,file.size,file.type],objectURL}));`,
  'non-terminal REPL evaluates sync await multiline and commands':`
    import repl from 'node:repl';import {PassThrough} from 'node:stream';
    const run=async source=>{const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',chunk=>text+=chunk);const server=repl.start({input,output,terminal:false,prompt:'P> ',useColors:false});const exited=new Promise(resolve=>server.once('exit',resolve));input.end(source);await exited;return text};console.log(JSON.stringify({sync:await run('1+2\\n.exit\\n'),await:await run('await Promise.resolve(7)\\n.exit\\n'),multiline:await run('function fixture(){\\nreturn 4\\n}\\nfixture()\\n.exit\\n'),clear:await run('.clear\\n.exit\\n'),writer:repl.writer({a:1}),builtins:repl.builtinModules.slice(0,5)}));`,
  'test reporters transform the minimal deterministic event model':`
    import reporters from 'node:test/reporters';import {once} from 'node:events';
    const events=[{type:'test:start',data:{nesting:0,name:'passes',file:'fixture.mjs'}},{type:'test:pass',data:{name:'passes',nesting:0,testNumber:1,details:{duration_ms:1,type:'test'},file:'fixture.mjs'}},{type:'test:start',data:{nesting:0,name:'skips',file:'fixture.mjs'}},{type:'test:pass',data:{name:'skips',nesting:0,testNumber:2,details:{duration_ms:0,type:'test'},skip:'why',file:'fixture.mjs'}},{type:'test:plan',data:{nesting:0,count:2}},{type:'test:diagnostic',data:{nesting:0,message:'tests 2'}},{type:'test:diagnostic',data:{nesting:0,message:'pass 1'}},{type:'test:diagnostic',data:{nesting:0,message:'skipped 1'}},{type:'test:summary',data:{success:true,counts:{tests:2,passed:1,skipped:1},duration_ms:1}}],source=()=>({async *[Symbol.asyncIterator](){yield* events}});const generated=async fn=>{let output='';for await(const chunk of fn(source()))output+=chunk;return output},transformed=async fn=>{const stream=fn(),chunks=[];stream.on('data',chunk=>chunks.push(String(chunk)));for(const event of events)stream.write(event);stream.end();await once(stream,'end');return chunks.join('')};console.log(JSON.stringify({tap:await generated(reporters.tap),dot:await generated(reporters.dot),junit:await generated(reporters.junit),spec:await transformed(reporters.spec),lcov:'lcov' in reporters}));`,
  'stream consumers collect Node, async iterable and Web streams':`
    import consumers from 'node:stream/consumers';import {Readable} from 'node:stream';
    const utf8=()=>Readable.from([Buffer.from([65,240,159]),Buffer.from([166]),Buffer.from([138,66])]),iterable=()=>({async *[Symbol.asyncIterator](){yield new Uint8Array([0,255]);yield 'ok'}}),web=()=>new ReadableStream({start(controller){controller.enqueue(new Uint8Array([104,195]));controller.enqueue(new Uint8Array([169]));controller.close()}});const binary=await consumers.buffer(iterable()),byteArray=await consumers.bytes(iterable()),array=await consumers.arrayBuffer(iterable()),valueBlob=await consumers.blob(iterable());let parse;try{await consumers.json(Readable.from(['{"broken"']))}catch(error){parse=error.name}const once=Readable.from(['once']),webOnce=web();console.log(JSON.stringify({text:await consumers.text(utf8()),web:await consumers.text(web()),binary:[...binary],bytes:[...byteArray],bytesType:byteArray.constructor.name,bytesIsBuffer:Buffer.isBuffer(byteArray),bytesOffset:byteArray.byteOffset,array:[...new Uint8Array(array)],blob:[...new Uint8Array(await valueBlob.arrayBuffer())],type:valueBlob.type,parse,once:[await consumers.text(once),await consumers.text(once)],webOnce:[await consumers.text(webOnce),await consumers.text(webOnce)]}));`,
  'diagnostics channels publish and trace synchronous and promise work':`
    import diagnostics from 'node:diagnostics_channel';
    const name='framework.instrumentation',channel=diagnostics.channel(name),messages=[];const listener=(message,seenName)=>messages.push([message,seenName]);diagnostics.subscribe(name,listener);channel.publish({ready:true});const state=[channel===diagnostics.channel(name),channel.hasSubscribers,diagnostics.hasSubscribers(name),diagnostics.unsubscribe(name,listener),diagnostics.unsubscribe(name,listener)];
    const tracing=diagnostics.tracingChannel('request'),events=[];for(const part of ['start','end','asyncStart','asyncEnd','error'])tracing[part].subscribe(context=>events.push([part,{...context,error:context.error?.message}]));const sync=tracing.traceSync((a,b)=>a+b,{kind:'sync'},null,2,3);let failed;try{await tracing.tracePromise(async()=>{throw Error('failed')},{kind:'promise'})}catch(error){failed=error.message}console.log(JSON.stringify({messages,state,sync,failed,events}));`,
  'modern value inspection matches Node':`
    import {inspect} from 'node:util';
    const values=[new Map([['a',1]]),new Set([1,2]),123n,Symbol('x'),{[Symbol.for('nodejs.util.inspect.custom')](){return 'custom result'}}];
    console.log(JSON.stringify(values.map(value=>inspect(value))));`,
  'util types subpath exposes common framework predicates and shared identities':`
    import types,{isMap,isSet,isTypedArray,isDataView,isPromise,isBoxedPrimitive,isRegExp,isNativeError} from 'node:util/types';import {types as fromUtil} from 'node:util';import {createRequire} from 'node:module';
    const require=createRequire('/probe.cjs'),values=[new Map(),new Set(),new Uint8Array(),new DataView(new ArrayBuffer(1)),Promise.resolve(),new Number(1),/x/,new Error('x')],predicates=[isMap,isSet,isTypedArray,isDataView,isPromise,isBoxedPrimitive,isRegExp,isNativeError];
    console.log(JSON.stringify([types===fromUtil,require('util/types')===types,predicates.map((predicate,index)=>values.map(predicate).map((value,item)=>value&&item===index))]));`,
  'terminal control stripping handles CSI, OSC, hyperlinks and plain Unicode':`
    import util,{stripVTControlCharacters as strip} from 'node:util';
    const esc=String.fromCharCode(27),csi=String.fromCharCode(155),st=String.fromCharCode(156),bell=String.fromCharCode(7);
    const values=['plain 🦊 text',esc+'[31mred'+esc+'[0m',csi+'2Jhello',esc+']0;title'+bell+'body',esc+']8;;https://example.com'+esc+'\\\\link'+esc+']8;;'+esc+'\\\\',esc+']0;title'+st+'body',esc+'[?25lhidden'+esc+'[?25h',esc+'[38;2;1;2;3mcolor'+esc+'[0m',esc+']unterminated',esc+'[',esc+'[31m'.repeat(1000)+'text', 'tabs\\tand\\nnewlines'];
    console.log(JSON.stringify([util.stripVTControlCharacters===strip,values.map(strip),values.map(strip)]));`,
  'terminal control stripping rejects non-strings without coercion':`
    import {stripVTControlCharacters as strip} from 'node:util';let coerced=false;
    const values=[undefined,null,42,[],new String('text'),Symbol('text'),{toString(){coerced=true;return 'text'}}];
    console.log(JSON.stringify([values.map(value=>{try{return strip(value)}catch(error){return [error.name,error.code]}}),coerced]));`,
  'filesystem promises shares the constants object across import styles':`
    import fs from 'node:fs';import promises,{constants} from 'node:fs/promises';import {createRequire} from 'node:module';
    const require=createRequire('/probe.cjs');
    console.log(JSON.stringify([constants===fs.constants,constants===promises.constants,constants===require('node:fs/promises').constants,constants===require('fs').constants,constants.F_OK,constants.R_OK,constants.W_OK,constants.X_OK]));`,
  'builtin recognition does not coerce values and exposes an immutable catalog':`
    import module,{builtinModules,isBuiltin} from 'node:module';import {createRequire} from 'node:module';
    const require=createRequire('/probe.cjs');let coerced=false;
    const values=[undefined,null,42,{},['fs'],Symbol('fs'),{toString(){coerced=true;return 'fs'}},'fs','node:fs','fs/promises','node:fs/promises','node:node:fs','not-a-builtin','node:'];
    let mutation=false;try{builtinModules.push('injected')}catch{mutation=true}
    console.log(JSON.stringify([values.map(isBuiltin),coerced,Object.isFrozen(builtinModules),mutation,isBuiltin('injected'),module.builtinModules===builtinModules,require('module').builtinModules===builtinModules]));`,
}
for(const guestWasm of [false,true]){
  for(const [name,source] of Object.entries(cases))test(`${guestWasm?'WASM bridge':'default engine'}: ${name}`,async({page},info)=>{
    const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000})
    expect(node.status,node.stderr).toBe(0)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({source,guestWasm})=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
      try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,maxBytes:64*1024*1024})}finally{kernel.close()}
    },{source,guestWasm})
    await info.attach('node-comparison.json',{body:JSON.stringify({node:node.stdout,nodeVersion:process.version,result}),contentType:'application/json'})
    expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(node.stdout)
  })
  test(`${guestWasm?'WASM bridge':'default engine'}: every advertised builtin resolves and imports`,async({page})=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async guestWasm=>{
      const source=`import {builtinModules,isBuiltin,createRequire} from 'node:module';const require=createRequire('/main.mjs');const names=[];for(const name of builtinModules){if(!isBuiltin(name)||!isBuiltin('node:'+name))throw Error('Unrecognized catalog entry');if(require.resolve(name)!=='node:'+name)throw Error('Incorrect builtin resolution');await import('node:'+name);names.push(name)}console.log(JSON.stringify(names));`
      const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
      try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,maxBytes:64*1024*1024,timeoutMs:30000})}finally{kernel.close()}
    },guestWasm)
    expect(result.exitCode,result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(Object.keys(artifact.modules).map(name=>name.slice(5)).sort())
  })
}
