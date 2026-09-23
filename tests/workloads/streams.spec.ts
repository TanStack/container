import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const cases:Record<string,string>={
  'Node and Web readable adapters copy bytes and retain reader ownership':`
    import {Readable} from 'node:stream';import {Buffer} from 'node:buffer';
    const web=new ReadableStream({start(c){c.enqueue(new Uint8Array([65,66]));c.close()}}),node=Readable.fromWeb(web),seen=[];
    for await(const chunk of node)seen.push([Buffer.isBuffer(chunk),chunk.toString()]);
    const output=Readable.toWeb(Readable.from([Buffer.from('cd')],{objectMode:false}));
    for await(const chunk of output)seen.push([chunk instanceof Uint8Array,Buffer.isBuffer(chunk),new TextDecoder().decode(chunk)]);
    seen.push(web.locked);console.log(JSON.stringify(seen));`,
  'Node and Web writable adapters preserve writes and close':`
    import {Writable} from 'node:stream';import {finished} from 'node:stream/promises';const seen=[];
    const web=new WritableStream({write(chunk){seen.push(new TextDecoder().decode(chunk))},close(){seen.push('web-close')}}),node=Writable.fromWeb(web);
    node.end('ab');await finished(node);seen.push(web.locked);
    const sink=new Writable({write(chunk,_encoding,done){seen.push(chunk.toString());setTimeout(done,1)},final(done){seen.push('node-final');done()}});
    const writer=Writable.toWeb(sink).getWriter();await writer.write(new TextEncoder().encode('cd'));await writer.close();seen.push(sink.writableFinished);
    console.log(JSON.stringify(seen));`,
  'Web adapters preserve byte and chunk queue limits':`
    import {Readable,Writable} from 'node:stream';import {Buffer} from 'node:buffer';
    let reads=0;const r=new Readable({highWaterMark:4,read(){reads++;this.push(Buffer.alloc(4))}}),web=Readable.toWeb(r);
    await new Promise(r=>setTimeout(r,10));const seen=[reads,r.readableLength,r.isPaused()];await web.cancel();
    const sink=new Writable({highWaterMark:7,write(c,e,done){done()}}),writer=Writable.toWeb(sink).getWriter();seen.push(writer.desiredSize);await writer.close();console.log(JSON.stringify(seen));`,
  'adapter cancellation reaches the underlying stream':`
    import {Readable,Writable} from 'node:stream';import {finished} from 'node:stream/promises';const seen=[],reason=Error('stop');
    const web=new ReadableStream({cancel(error){seen.push(error===reason)}}),node=Readable.fromWeb(web);node.destroy(reason);try{await finished(node)}catch(error){seen.push(error===reason)};
    const source=new Readable({read(){},destroy(error,done){seen.push(error===reason);done(error)}});await Readable.toWeb(source).cancel(reason);
    const sink=new Writable({write(_c,_e,done){done()},destroy(error,done){seen.push(error===reason);done(error)}});await Writable.toWeb(sink).abort(reason);
    console.log(JSON.stringify(seen));`,
  'duplex adapters roundtrip a transform':`
    import {Duplex} from 'node:stream';const pair=new TransformStream({transform(chunk,c){c.enqueue(chunk.toUpperCase())}});
    const duplex=Duplex.fromWeb(pair,{objectMode:true}),output=[];duplex.end('hello');for await(const chunk of duplex)output.push(chunk);
    console.log(JSON.stringify(output));`,
  'duplex converts back to a Web pair':`
    import {Duplex,Transform} from 'node:stream';const node=new Transform({transform(chunk,_encoding,done){done(null,chunk.toString().toUpperCase())}});
    const pair=Duplex.toWeb(node),writer=pair.writable.getWriter(),seen=[];
    const reading=(async()=>{for await(const chunk of pair.readable)seen.push(new TextDecoder().decode(chunk))})();await writer.write(new TextEncoder().encode('hello'));await writer.close();await reading;console.log(JSON.stringify(seen));`,
  'duplex adapter keeps buffering options and clean destruction':`
    import {Duplex} from 'node:stream';const seen=[];
    for(const options of [{highWaterMark:7},{objectMode:true,highWaterMark:3,allowHalfOpen:true}]){
      const pair=new TransformStream(),d=Duplex.fromWeb(pair,options);
      seen.push([d.readableObjectMode,d.writableObjectMode,d.readableHighWaterMark,d.writableHighWaterMark,d.allowHalfOpen]);
      const errors=[];d.on('error',e=>errors.push(e.code));const closed=new Promise(r=>d.once('close',r));d.destroy();await closed;seen.push([errors,pair.readable.locked,pair.writable.locked]);
    }console.log(JSON.stringify(seen));`,
  'duplex adapter propagates cancellation to both halves':`
    import {Duplex} from 'node:stream';import {finished} from 'node:stream/promises';const reason=Error('stop'),seen=[];
    const d=Duplex.fromWeb({readable:new ReadableStream({cancel(e){seen.push(['read',e===reason])}}),writable:new WritableStream({abort(e){seen.push(['write',e===reason])}})});
    const done=finished(d);d.destroy(reason);try{await done}catch(e){seen.push(['error',e===reason])}console.log(JSON.stringify(seen));`,
  'Web source and sink failures propagate through adapters':`
    import {Readable,Writable} from 'node:stream';import {finished} from 'node:stream/promises';const seen=[],reason=Error('broken');
    const r=Readable.fromWeb(new ReadableStream({pull(){throw reason}}));try{for await(const _ of r){}}catch(e){seen.push(e===reason,r.destroyed)};
    const w=Writable.fromWeb(new WritableStream({write(){throw reason}}));w.end('x');try{await finished(w)}catch(e){seen.push(e===reason,w.destroyed)};console.log(JSON.stringify(seen));`,
  'premature Node close rejects a Web reader':`
    import {Readable} from 'node:stream';const r=new Readable({read(){this.destroy()}});try{for await(const _ of Readable.toWeb(r)){}}catch(e){console.log(JSON.stringify([e.name,e.code,e.cause?.code]))}`, 
  'fromWeb abort signals destroy their adapters':`
    import {Readable,Writable} from 'node:stream';import {finished} from 'node:stream/promises';const seen=[];
    for(const kind of ['read','write']){const c=new AbortController();const s=kind==='read'?Readable.fromWeb(new ReadableStream(),{signal:c.signal}):Writable.fromWeb(new WritableStream(),{signal:c.signal});const pending=finished(s);c.abort();try{await pending}catch(e){seen.push([e.name,e.code,s.destroyed])}}console.log(JSON.stringify(seen));`,
  'virtual output is not a terminal':`
    import tty from 'node:tty';console.log(JSON.stringify([-1,0,1,2,999,'x',null].map(fd=>tty.isatty(fd))));`,
  'pipeline transforms bytes and propagates async context':`
    import {Readable,Transform,Writable} from 'node:stream';import {pipeline} from 'node:stream/promises';import {AsyncLocalStorage} from 'node:async_hooks';
    const als=new AsyncLocalStorage(),seen=[];
    await als.run('pipe',async()=>{
      await pipeline(Readable.from(['a','b']),new Transform({transform(chunk,encoding,done){seen.push(als.getStore());setTimeout(()=>done(null,chunk.toString().toUpperCase()),1)}}),new Writable({write(chunk,encoding,done){seen.push(chunk.toString(),als.getStore());done()}}));
      seen.push(als.getStore());
    });console.log(JSON.stringify(seen));`,
  'backpressure, cork, writev, finish, and close':`
    import {Writable} from 'node:stream';import {finished} from 'node:stream/promises';
    const seen=[],w=new Writable({highWaterMark:2,write(chunk,encoding,done){seen.push(chunk.toString());setTimeout(done,1)},writev(chunks,done){seen.push(chunks.map(c=>c.chunk.toString()));setTimeout(done,1)}});
    w.on('drain',()=>seen.push('drain'));w.on('finish',()=>seen.push('finish'));w.on('close',()=>seen.push('close'));
    w.cork();seen.push(w.write('a'),w.write('b'));w.uncork();await new Promise(r=>w.once('drain',r));w.end('c');await finished(w);console.log(JSON.stringify(seen));`,
  'pipeline errors destroy all stages':`
    import {Readable,Transform,Writable} from 'node:stream';import {pipeline} from 'node:stream/promises';
    const source=Readable.from(['a','b']),transform=new Transform({transform(_c,_e,done){done(Error('transform failed'))}}),sink=new Writable({write(_c,_e,done){done()}});
    try{await pipeline(source,transform,sink)}catch(e){console.log(JSON.stringify([e.message,source.destroyed,transform.destroyed,sink.destroyed]))}`, 
  'async iterators return early and release their producer':`
    import {Readable} from 'node:stream';const seen=[];
    const stream=Readable.from((async function*(){try{yield 1;yield 2;yield 3}finally{seen.push('released')}})());
    for await(const value of stream){seen.push(value);break}await new Promise(r=>setTimeout(r,5));console.log(JSON.stringify([seen,stream.destroyed]));`,
  'abort cancels pipeline and preserves its reason':`
    import {Readable,Writable} from 'node:stream';import {pipeline} from 'node:stream/promises';
    const controller=new AbortController(),source=new Readable({read(){}}),sink=new Writable({write(_c,_e,done){done()}});
    const pending=pipeline(source,sink,{signal:controller.signal});controller.abort(Error('stop'));
    try{await pending}catch(e){console.log(JSON.stringify([e.name,e.code,source.destroyed,sink.destroyed]))}`, 
  'shared stream, event, buffer, and promise identities':`
    import Stream,{Readable,PassThrough,Writable} from 'node:stream';import {EventEmitter} from 'node:events';import {pipeline} from 'node:stream/promises';import {Buffer} from 'node:buffer';
    const p=new PassThrough();p.end('ok');const chunks=[];for await(const chunk of p)chunks.push([Buffer.isBuffer(chunk),chunk.toString()]);
    console.log(JSON.stringify([p instanceof Stream,p instanceof EventEmitter,p instanceof Readable,p instanceof Writable,Stream.promises.pipeline===pipeline,chunks]));`,
  'Node stream state helpers track reading and destruction':`
    import {Readable,isDestroyed,isDisturbed,isErrored,isReadable,destroy} from 'node:stream';
    const r=Readable.from([1]),seen=[];seen.push([isDestroyed(r),isDisturbed(r),isErrored(r),isReadable(r)]);
    for await(const value of r)seen.push(value);seen.push([isDestroyed(r),isDisturbed(r),isErrored(r),isReadable(r)]);
    const failed=new Readable({read(){}}),reason=Error('stop');const closed=new Promise(r=>failed.once('close',r));failed.on('error',()=>{});destroy(failed,reason);await closed;seen.push([isDestroyed(failed),isErrored(failed)]);console.log(JSON.stringify(seen));`,
  'async stream operators retain ordered output and context':`
    import {Readable} from 'node:stream';import {AsyncLocalStorage} from 'node:async_hooks';
    const als=new AsyncLocalStorage(),seen=[];await als.run('map',async()=>{
      const values=await Readable.from([1,2,3]).map(async value=>{await new Promise(r=>setTimeout(r,4-value));return [value*2,als.getStore()]},{concurrency:3}).filter(value=>value[0]>2).toArray();seen.push(values,als.getStore());
    });console.log(JSON.stringify(seen));`,
  'process output writes exact chunks and does not end on pipe completion':`
    import process from 'node:process';import {Readable,Writable} from 'node:stream';import {Buffer} from 'node:buffer';
    process.stdout.write('a');process.stdout.write(Buffer.from([0xe2]));process.stdout.write(Buffer.from([0x82,0xac]));process.stderr.write('error');
    await new Promise(resolve=>{const r=Readable.from(['b','c']);r.on('end',resolve);r.pipe(process.stdout)});
    process.stdout.write('d\\n');console.log(JSON.stringify([process.stdout instanceof Writable,process.stderr instanceof Writable,process.stdout.writableEnded,process.stdout.fd,process.stderr.fd,!!process.stdout.isTTY]));`,
  'incomplete UTF-8 is decoded in order with console and stderr':`
    import process from 'node:process';import {Buffer} from 'node:buffer';process.stdout.write(Buffer.from([0xe2]));console.log('x');process.stderr.write(Buffer.from([0xff]));process.stdout.write(Buffer.from([0xf0,0x9f]));`,
}
for(const [name,source] of Object.entries(cases))for(const mode of ['modules','bundle'] as const)for(const webAPIs of name==='process output writes exact chunks and does not end on pipe completion'?[true,false]:[true]){
  test('Node streams | '+mode+' | '+name+(webAPIs?'':' | without Web APIs'),async({page})=>{
    const node=spawnSync(process.execPath,['--input-type=module'],{input:source,encoding:'utf8',timeout:10000,env:{...process.env,FORCE_COLOR:'0'}})
    expect(node.status,node.stderr).toBe(0)
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({source,mode,webAPIs})=>{
      const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':source})
      try{return await (mode==='modules'?kernel.runModule('/entry.mjs',{webAPIs}):kernel.run('/entry.mjs',{webAPIs}))}finally{kernel.close()}
    },{source,mode,webAPIs})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(result.stdout).toBe(node.stdout);expect(result.stderr).toBe(node.stderr)
  })
}

test('Node streams | output quota fails and the owner recovers',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':`import process from 'node:process';import {Buffer} from 'node:buffer';const chunk=Buffer.alloc(16384,120);for(let i=0;i<65;i++)process.stdout.write(chunk)`})
    try{return {failed:await kernel.runModule('/entry.mjs'),recovered:await kernel.execute('console.log(42)')}}finally{kernel.close()}
  })
  expect(result.failed.exitCode).toBe(1);expect(result.failed.stderr).toContain('Output quota exceeded');expect(result.failed.stdout.length).toBe(1048576)
  expect(result.recovered.exitCode).toBe(0);expect(result.recovered.stdout).toBe('42\n')
})

for(const mode of ['modules','bundle'] as const)test('Node streams | '+mode+' | pure streams work without optional Web APIs',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async mode=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/entry.mjs':`import {Readable,Transform,Writable} from 'node:stream';import {pipeline} from 'node:stream/promises';import process from 'node:process';const seen=[];await pipeline(Readable.from(['ab']),new Transform({transform(c,e,cb){cb(null,c.toString().toUpperCase())}}),new Writable({write(c,e,cb){seen.push(c.toString());cb()}}));process.stdout.write(JSON.stringify(seen));console.log(typeof ReadableStream);try{Readable.toWeb(Readable.from([]))}catch(e){console.log(e.code)}`})
    try{return await (mode==='modules'?kernel.runModule('/entry.mjs'):kernel.run('/entry.mjs'))}finally{kernel.close()}
  },mode)
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe('["AB"]undefined\nERR_UNSUPPORTED_OPERATION\n')
})
