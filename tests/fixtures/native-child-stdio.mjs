const cases=[
  {name:'pipe'},
  {name:'ignore',stdio:'ignore'},
  {name:'mixed',stdio:['ignore','pipe','ignore']},
  {name:'ignore-stdout',stdio:['pipe','ignore','pipe']},
  {name:'ignore-stderr',stdio:['pipe','pipe','ignore']},
  {name:'defaults',stdio:[null,'ignore','pipe']},
  {name:'large-ignore',stdio:'ignore',large:true},
]
export const nativeChildStdioFiles={
  '/app/stdio-explicit-ipc.cjs':`const chunks=[];let request,ended=false,sent=false;
    const finish=()=>{if(!ended||request===undefined||sent)return;sent=true;
      process.stdout.write(Buffer.from([0,128,255]));process.stderr.write(Buffer.from([255,128,0]));
      process.send({input:Buffer.concat(chunks).toString('hex'),request},()=>process.disconnect());};
    process.on('message',value=>{request=value;finish()});
    process.stdin.on('data',bytes=>chunks.push(bytes));process.stdin.on('end',()=>{ended=true;finish()});process.stdin.resume();`,
  '/app/stdio-inherit-child.cjs':`if(process.argv[2]==='large'){
    const out=Buffer.alloc(1024*1024),err=Buffer.alloc(1024*1024);
    for(let i=0;i<out.length;i++){out[i]=i%256;err[i]=255-i%256}
    process.stdout.write(out);process.stderr.write(err);
  }else{process.stdout.write(Buffer.from([0,128,255,10]));process.stderr.write(Buffer.from([255,128,0,10]));}`,
  '/app/stdio-inherit-parent.cjs':`const child=require('node:child_process').spawn(process.execPath,['stdio-inherit-child.cjs',...process.argv.slice(2)],{stdio:['ignore','inherit','inherit']});
    if(child.stdin!==null||child.stdout!==null||child.stderr!==null)throw Error('Inherited streams must be null');
    child.on('error',error=>{throw error});child.on('close',code=>{process.exitCode=code});`,
  '/app/stdio-import-fork-child.cjs':`process.send({loaded:globalThis.preloadEvents.includes('first-done'),inherited:process.execArgv.includes('--import=./stdio-import-first.mjs')},()=>process.disconnect());`,
  '/app/stdio-import-fork-parent.cjs':`const child=require('node:child_process').fork('./stdio-import-fork-child.cjs',[],{stdio:'ignore'});let message;
    child.once('message',value=>message=value);child.once('close',code=>console.log(JSON.stringify({code,message,parentLoaded:globalThis.preloadEvents.includes('first-done')})));`,
  '/app/stdio-parallel-require.cjs':'globalThis.preloadGate=new Promise(resolve=>globalThis.releasePreload=resolve);',
  '/app/stdio-parallel-first.mjs':'await globalThis.preloadGate;globalThis.parallelFirst=41;',
  '/app/stdio-parallel-second.mjs':'globalThis.releasePreload();globalThis.parallelSecond=1;',
  '/app/stdio-import-pending.mjs':'await new Promise(()=>{});',
  '/app/stdio-import-exit-seven.mjs':'process.exitCode=7;await new Promise(()=>{});',
  '/app/stdio-import-throw.mjs':'throw Error("preload failure");',
  '/app/stdio-import-unreached.cjs':'console.log("entry must not run");',
  '/app/stdio-require-preload.cjs':'globalThis.preloadEvents=["require"];',
  '/app/stdio-import-first.mjs':'globalThis.preloadEvents.push("first-start");await new Promise(resolve=>setTimeout(resolve,20));globalThis.preloadEvents.push("first-done");',
  '/app/stdio-import-second.mjs':'globalThis.preloadEvents.push("second-done");',
  '/app/stdio-import-entry.cjs':'globalThis.preloadEvents.push("entry");console.log(JSON.stringify({first:globalThis.preloadEvents[0],last:globalThis.preloadEvents.at(-1),events:[...globalThis.preloadEvents].sort()}));',
  '/app/stdio-delayed-listener.cjs':`setTimeout(()=>process.on('message',value=>{
    console.log('message:'+value);setImmediate(()=>process.disconnect());
  }),25);`,
  '/app/stdio-parent-disconnect.cjs':`const done=()=>console.log('closed:'+process.connected);
    process.on('message',value=>console.log('message:'+value));
    if(process.connected){process.once('disconnect',done);if(process.argv[2]==='ready')process.send('ready')}
    else done();`,
  '/app/stdio-echo.cjs':'process.stdin.on("data",bytes=>process.stdout.write(bytes));process.stdin.resume();',
  '/app/stdio-exit.cjs':'console.log("done");process.exit(0);',
  '/app/stdio-ipc.cjs':`process.stdin.resume();process.stdin.on('end',()=>{
    process.stdout.write('fork ignored marker\\n');process.stderr.write('fork ignored marker\\n');
    process.send({eof:true},()=>process.disconnect());
  });`,
  '/app/stdio-child.cjs':`if(process.argv[2]==='large'){
    process.stdout.write(Buffer.alloc(4*1024*1024,65));process.stderr.write(Buffer.alloc(4*1024*1024,66));
  }else{
    let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',value=>input+=value);
    process.stdin.on('end',()=>{process.stdout.write('out:'+input+'\\n');process.stderr.write('err\\n')});
    process.stdin.resume();
  }`,
  '/app/stdio-main.cjs':`const {spawn,fork,execFile}=require('node:child_process');const {writeFileSync}=require('node:fs');
  (async()=>{
    const results=[];
    for(const options of ${JSON.stringify(cases)}){
      const child=spawn(process.execPath,['stdio-child.cjs',...(options.large?['large']:[])],{stdio:options.stdio});
      let stdout='',stderr='';child.stdout?.on('data',bytes=>stdout+=bytes.toString());child.stderr?.on('data',bytes=>stderr+=bytes.toString());
      const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))});
      child.stdin?.end('input');
      const status=await closed;
      results.push({name:options.name,stdin:child.stdin!==null,stdinDestroyed:child.stdin?.destroyed??null,stdinWritable:child.stdin?.writable??null,stdoutPipe:child.stdout!==null,stderrPipe:child.stderr!==null,...status,stdout,stderr});
    }
    const captured=await new Promise((resolve,reject)=>execFile(process.execPath,['-e','console.log("captured")'],{stdio:'ignore'},(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
    const child=fork('./stdio-ipc.cjs',[],{stdio:'ignore',execArgv:[]});let message;const ipcEvents=[];
    child.once('message',value=>message=value);
    child.once('disconnect',()=>ipcEvents.push({event:'disconnect',connected:child.connected}));
    child.once('exit',()=>ipcEvents.push({event:'exit',connected:child.connected}));
    const closed=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))});
    const ipc={stdin:child.stdin!==null,stdout:child.stdout!==null,stderr:child.stderr!==null,message,events:ipcEvents,...closed};
    const explicit=fork('./stdio-explicit-ipc.cjs',[],{stdio:['pipe','pipe','pipe','ipc'],execArgv:[]});
    let explicitMessage;const explicitOut=[],explicitErr=[];
    explicit.stdout.on('data',bytes=>explicitOut.push(bytes));explicit.stderr.on('data',bytes=>explicitErr.push(bytes));
    explicit.on('message',value=>explicitMessage=value);
    const explicitClosed=new Promise((resolve,reject)=>{explicit.once('error',reject);explicit.once('close',(code,signal)=>resolve({code,signal}))});
    const descriptorShape=explicit.stdio.length===4&&explicit.stdio[0]===explicit.stdin&&explicit.stdio[1]===explicit.stdout&&explicit.stdio[2]===explicit.stderr&&explicit.stdio[3]===null;
    explicit.send({answer:42});explicit.stdin.end(Buffer.from([0,128,255]));
    const explicitIPC={...await explicitClosed,descriptorShape,message:explicitMessage,stdout:Buffer.concat(explicitOut).toString('hex'),stderr:Buffer.concat(explicitErr).toString('hex')};
    const early=spawn(process.execPath,['stdio-exit.cjs']);let exit,stdout='';
    early.stdout.on('data',bytes=>stdout+=bytes.toString());early.stderr.resume();
    early.once('exit',()=>exit={destroyed:early.stdin.destroyed,writable:early.stdin.writable});
    const status=await new Promise((resolve,reject)=>{early.once('error',reject);early.once('close',(code,signal)=>resolve({code,signal}))});
    const earlyExit={exit,destroyed:early.stdin.destroyed,writable:early.stdin.writable,stdout,...status};
    const echo=spawn(process.execPath,['stdio-echo.cjs']);let bytes=0,checksum=0;
    echo.stdout.on('data',chunk=>{bytes+=chunk.length;for(const value of chunk)checksum+=value});echo.stderr.resume();
    const echoClosed=new Promise((resolve,reject)=>{echo.once('error',reject);echo.once('close',(code,signal)=>resolve({code,signal}))});
    const chunk=Buffer.alloc(65536);for(let index=0;index<chunk.length;index++)chunk[index]=index%256;
    for(let index=0;index<64;index++)await new Promise((resolve,reject)=>echo.stdin.write(chunk,error=>error?reject(error):resolve()));
    echo.stdin.end();const echoStatus=await echoClosed;
    const roundtrip={bytes,checksum,destroyed:echo.stdin.destroyed,writable:echo.stdin.writable,...echoStatus};
    const parentDisconnect=[];
    for(const when of ['early','ready','queued']){
      const child=fork('./stdio-parent-disconnect.cjs',[when],{silent:true,stdio:'pipe',execArgv:[]});let stdout='';const events=[];
      child.stdout.on('data',bytes=>stdout+=bytes.toString());child.stderr.resume();
      child.once('disconnect',()=>events.push({event:'disconnect',connected:child.connected}));
      child.once('exit',()=>events.push({event:'exit',connected:child.connected}));
      const drained=new Promise(resolve=>child.stdout.once('end',resolve));
      const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))});
      if(when==='ready')await new Promise(resolve=>child.once('message',resolve));
      if(when==='queued')child.send('queued');
      child.disconnect();const connected=child.connected;child.stdin.end();
      const status=await closed;await drained;parentDisconnect.push({when,connected,stdout,events,...status});
    }
    const delayed=fork('./stdio-delayed-listener.cjs',[],{stdio:'pipe',execArgv:[]});let delayedOutput='';
    delayed.stdout.on('data',bytes=>delayedOutput+=bytes.toString());delayed.stderr.resume();
    const delayedClosed=new Promise((resolve,reject)=>{delayed.once('error',reject);delayed.once('close',(code,signal)=>resolve({code,signal}))});
    delayed.send('delayed');delayed.stdin.end();const delayedStatus=await delayedClosed;
    const delayedListener={stdout:delayedOutput,...delayedStatus};
    const imports=await new Promise((resolve,reject)=>execFile(process.execPath,[
      '--import=./stdio-import-first.mjs','--require','./stdio-require-preload.cjs',
      '--import',require('node:url').pathToFileURL(require('node:path').resolve('stdio-import-second.mjs')).href,
      '--import','./stdio-import-first.mjs','stdio-import-entry.cjs',
    ],(error,stdout,stderr)=>error?reject(error):resolve({result:JSON.parse(stdout),stderr})));
    const importFailures=[];
    for(const name of ['pending','exit-seven','throw','missing']){
      const child=spawn(process.execPath,['--import','./stdio-import-'+name+'.mjs','stdio-import-unreached.cjs']);let stdout='',stderr='';
      child.stdout.on('data',bytes=>stdout+=bytes.toString());child.stderr.on('data',bytes=>stderr+=bytes.toString());
      const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))});
      importFailures.push({name,stdout,stderrEmpty:stderr==='',unsettled:/unsettled top-level await/i.test(stderr),preloadError:stderr.includes('preload failure'),...status});
    }
    const preloadSequence=await new Promise((resolve,reject)=>execFile(process.execPath,[
      '--require','./stdio-parallel-require.cjs','--import','./stdio-parallel-first.mjs',
      '--import','./stdio-parallel-second.mjs','-e','console.log(globalThis.parallelFirst+globalThis.parallelSecond)',
    ],(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
    const inheritedImports=await new Promise((resolve,reject)=>execFile(process.execPath,[
      '--require','./stdio-require-preload.cjs','--import=./stdio-import-first.mjs','stdio-import-fork-parent.cjs',
    ],(error,stdout,stderr)=>error?reject(error):resolve({result:JSON.parse(stdout),stderr})));
    const inheritedOutput=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['stdio-inherit-parent.cjs']);const out=[],err=[];
      child.stdout.on('data',bytes=>out.push(bytes));child.stderr.on('data',bytes=>err.push(bytes));child.stdin.end();
      child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout:Buffer.concat(out).toString('hex'),stderr:Buffer.concat(err).toString('hex')}));
    });
    const inheritedLarge=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['stdio-inherit-parent.cjs','large']);
      const streams={stdout:{bytes:0,mismatch:false},stderr:{bytes:0,mismatch:false}};
      for(const name of ['stdout','stderr']){
        const stream=child[name],state=streams[name];let paused=false;
        stream.on('data',chunk=>{
          for(let i=0;i<chunk.length;i++){const expected=(state.bytes+i)%256;if(chunk[i]!== (name==='stdout'?expected:255-expected))state.mismatch=true}
          state.bytes+=chunk.length;
          if(!paused){paused=true;stream.pause();setTimeout(()=>stream.resume(),25)}
        });
      }
      child.stdin.end();child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,...streams}));
    });
    writeFileSync('stdio-result.json',JSON.stringify({results,captured,ipc,explicitIPC,earlyExit,roundtrip,parentDisconnect,delayedListener,imports,importFailures,preloadSequence,inheritedImports,inheritedOutput,inheritedLarge}));
  })().catch(error=>{console.error(error);process.exitCode=1});`,
}
export const nativeChildStdioExpected={results:cases.map(options=>{
  const modes=options.stdio===undefined?['pipe','pipe','pipe']:typeof options.stdio==='string'?[options.stdio,options.stdio,options.stdio]:options.stdio.map(mode=>mode??'pipe')
  return {name:options.name,stdin:modes[0]==='pipe',stdinDestroyed:modes[0]==='pipe'?true:null,stdinWritable:modes[0]==='pipe'?false:null,stdoutPipe:modes[1]==='pipe',stderrPipe:modes[2]==='pipe',code:0,signal:null,
    stdout:modes[1]==='pipe'?'out:'+(modes[0]==='pipe'?'input':'')+'\n':'',stderr:modes[2]==='pipe'?'err\n':''}
}),captured:{stdout:'captured\n',stderr:''},ipc:{stdin:false,stdout:false,stderr:false,message:{eof:true},events:[{event:'disconnect',connected:false},{event:'exit',connected:false}],code:0,signal:null},
earlyExit:{exit:{destroyed:true,writable:false},destroyed:true,writable:false,stdout:'done\n',code:0,signal:null},
explicitIPC:{code:0,signal:null,descriptorShape:true,message:{input:'0080ff',request:{answer:42}},stdout:'0080ff',stderr:'ff8000'},
roundtrip:{bytes:4194304,checksum:534773760,destroyed:true,writable:false,code:0,signal:null},
parentDisconnect:['early','ready','queued'].map(when=>({when,connected:false,stdout:(when==='queued'?'message:queued\n':'')+'closed:false\n',events:[{event:'disconnect',connected:false},{event:'exit',connected:false}],code:0,signal:null})),
delayedListener:{stdout:'message:delayed\n',code:0,signal:null},
imports:{result:{first:'require',last:'entry',events:['entry','first-done','first-start','require','second-done']},stderr:''},
importFailures:[
  {name:'pending',stdout:'',stderrEmpty:true,unsettled:false,preloadError:false,code:0,signal:null},
  {name:'exit-seven',stdout:'',stderrEmpty:true,unsettled:false,preloadError:false,code:7,signal:null},
  {name:'throw',stdout:'',stderrEmpty:false,unsettled:false,preloadError:true,code:1,signal:null},
  {name:'missing',stdout:'',stderrEmpty:false,unsettled:false,preloadError:false,code:1,signal:null},
],preloadSequence:{stdout:'',stderr:''},inheritedImports:{result:{code:0,message:{loaded:true,inherited:true},parentLoaded:true},stderr:''},
inheritedOutput:{code:0,signal:null,stdout:'0080ff0a',stderr:'ff80000a'},
inheritedLarge:{code:0,signal:null,stdout:{bytes:1048576,mismatch:false},stderr:{bytes:1048576,mismatch:false}}}
