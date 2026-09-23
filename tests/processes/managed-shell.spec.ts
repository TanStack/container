import {expect,test} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const nativeResult=(source:string)=>{
  const run=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000})
  expect(run.status,run.stderr).toBe(0)
  return run.stdout
}

const parityCases:Record<string,string>={
  'exec buffers stdout and stderr and exposes its promisify custom child':`
    import {exec} from 'node:child_process';import {promisify} from 'node:util';
    const execute=promisify(exec),pending=execute("printf 'hello'; printf 'warning' >&2");
    const result=await pending;
    console.log(JSON.stringify({result,child:typeof pending.child.pid==='number',custom:typeof exec[promisify.custom]==='function'}));`,
  'spawn shell streams output before exit and accepts stdin':`
    import {spawn} from 'node:child_process';
    const child=spawn("printf 'ready\\n'; read value; printf '%s' \"$value\"; printf 'problem' >&2",[],{shell:true});
    let stdout='',stderr='',closed=false,readyResolve;const ready=new Promise(resolve=>readyResolve=resolve);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('ready\\n'))readyResolve()});child.stderr.on('data',chunk=>stderr+=chunk);
    const done=new Promise(resolve=>child.on('close',(code,signal)=>{closed=true;resolve({code,signal})}));
    await ready;const streamed=!closed;child.stdin.end('two words\\n');const completion=await done;
    console.log(JSON.stringify({stdout,stderr,streamed,...completion}));`,
  'shell cwd environment quoting pipelines and redirects match bin sh':`
    import {exec} from 'node:child_process';import {promisify} from 'node:util';
    const command=String.raw\`printf '%s\\n' \"$VALUE\" 'two words' | node -e 'let s=\"\";process.stdin.on(\"data\",b=>s+=b);process.stdin.on(\"end\",()=>process.stdout.write(s.toUpperCase()))' > web-container-managed-shell-output; node -e 'const fs=require(\"node:fs\");process.stdout.write(process.cwd()+\"\\n\"+fs.readFileSync(\"web-container-managed-shell-output\",\"utf8\"));fs.unlinkSync(\"web-container-managed-shell-output\")'\`;
    const result=await promisify(exec)(command,{cwd:'/tmp',env:{VALUE:'quoted value'}});console.log(JSON.stringify(result));`,
  'exec and spawn shell preserve nonzero statuses and captured output':`
    import {exec,spawn} from 'node:child_process';import {promisify} from 'node:util';
    const failed=await promisify(exec)("printf 'out'; printf 'err' >&2; exit 7").catch(({code,signal,killed,stdout,stderr})=>({code,signal,killed,stdout,stderr}));
    const child=spawn('exit 9',[],{shell:true}),closed=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
    console.log(JSON.stringify({failed,closed}));`,
}

for(const [name,source] of Object.entries(parityCases))test(name,async({page},info)=>{
  const native=nativeResult(source)
  await page.goto('/sandbox.html')
  const guest=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source,'/tmp/.keep':''})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,timeoutMs:15000})}finally{kernel.close()}
  },source)
  await info.attach('native-control.txt',{body:native,contentType:'text/plain'})
  expect(guest.exitCode,guest.stderr).toBe(0)
  expect(guest.stdout).toBe(native)
})

test('shell timeout and AbortSignal cancellation leave the managed guest usable',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`
      import {exec} from 'node:child_process';import {promisify} from 'node:util';
      const execute=promisify(exec);
      const timeout=await execute('read value',{timeout:20}).catch(({signal,killed,cmd})=>({signal,killed,cmd}));
      const controller=new AbortController(),pending=execute('read value',{signal:controller.signal});controller.abort('cancelled');
      const aborted=await pending.catch(({name,code,cause,cmd})=>({name,code,cause,cmd}));
      const recovery=await execute("printf 'recovered'");console.log(JSON.stringify({timeout,aborted,recovery}));`})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    timeout:{signal:'SIGTERM',killed:true,cmd:'read value'},
    aborted:{name:'AbortError',code:'ABORT_ERR',cause:'cancelled',cmd:'read value'},
    recovery:{stdout:'recovered',stderr:''},
  })
})

test('numeric file descriptor redirects fail explicitly instead of being misdirected',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':`
      import {exec} from 'node:child_process';
      const result=await new Promise(resolve=>exec('printf unsafe >&3',(error,stdout,stderr)=>resolve({code:error?.code??null,stdout,stderr,message:error?.message??''})));
      console.log(JSON.stringify(result));`})
    try{return await kernel.runModule('/main.mjs',{guestWasm:true,timeoutMs:10000})}finally{kernel.close()}
  })
  expect(result.exitCode,result.stderr).toBe(0)
  const shell=JSON.parse(result.stdout)
  expect(shell.code).not.toBe(0)
  expect(shell.stdout).toBe('')
  expect(shell.stderr+shell.message).toMatch(/unsupported|file descriptor|redirection/i)
})
