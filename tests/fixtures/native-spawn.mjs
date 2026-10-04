export const nativeSpawnFiles={
  '/app/package.json':'{"type":"module"}',
  '/app/unread-child.js':'process.stdout.write("unread output");process.stderr.write("unread warning");',
  '/app/spawn-child.js':`import {writeFileSync} from 'node:fs';
if(typeof process.send!=='undefined')throw Error('Spawn unexpectedly has IPC');
if(process.argv[2]!=='space value'||process.argv[3]!=='--flag'||process.env.SPAWN_VALUE!=='present')throw Error('Launch arguments or environment lost');
process.stdin.on('data',chunk=>process.stdout.write(chunk));
process.stdin.on('end',()=>{writeFileSync('spawn-child-ended','yes');process.stderr.write('child warning\\n')});`,
  '/app/spawn-main.js':`import {spawn} from 'node:child_process';import {once} from 'node:events';import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['./spawn-child.js','space value','--flag'],{cwd:process.cwd(),env:{...process.env,SPAWN_VALUE:'present'}});
if(typeof child.send!=='undefined')throw Error('Spawn parent unexpectedly exposes IPC');
let spawned=false;const events=[];child.once('spawn',()=>{spawned=true;events.push('spawn')});
child.stdout.once('end',()=>events.push('stdout-end'));child.stderr.once('end',()=>events.push('stderr-end'));
child.once('exit',()=>events.push('exit'));child.once('close',()=>events.push('close'));
const stdout=[],stderr=[];child.stdout.on('data',chunk=>stdout.push(...chunk));child.stderr.on('data',chunk=>stderr.push(...chunk));
const closed=once(child,'close');child.stdin.end(new Uint8Array([255,0,240,159,152,128]));
const [code,signal]=await closed;
const unreadChild=spawn(process.execPath,['./unread-child.js'],{cwd:process.cwd()});
let stdoutEnded=false,stderrEnded=false;
unreadChild.stdout.once('end',()=>{stdoutEnded=true});unreadChild.stderr.once('end',()=>{stderrEnded=true});
const [unreadCode,unreadSignal]=await once(unreadChild,'close');
writeFileSync('spawn-result.json',JSON.stringify({spawned,code,signal,stdout,stderr:new TextDecoder().decode(new Uint8Array(stderr)),connected:child.connected,
closedAfterOutputEnd:events.indexOf('close')>events.indexOf('stdout-end')&&events.indexOf('stdout-end')>=0&&events.indexOf('close')>events.indexOf('stderr-end')&&events.indexOf('stderr-end')>=0,
unread:{code:unreadCode,signal:unreadSignal,stdoutEnded,stderrEnded}}));`,
}
