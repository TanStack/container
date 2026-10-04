export const nativeBinaryShellFiles={
  '/app/package.json':'{"type":"module"}',
  '/app/index.mjs':'export default {fetch(){return new Response("ready")}}',
  '/app/output-probe.js':'process.stdout.write(new Uint8Array([255,0,240]));process.stdout.write(new Uint8Array([159,152,128]));',
  '/app/error-probe.js':'process.stderr.write(new Uint8Array([255,0,240,159,152,128]));',
  '/app/burst-probe.js':'const chunk=new Uint8Array(65536);for(let i=0;i<chunk.length;i++)chunk[i]=i%251;for(let i=0;i<64;i++)process.stdout.write(chunk);',
  '/app/delayed-input-producer.js':`import {existsSync} from 'node:fs';
const mode=process.argv[2]??'data';
const deadline=Date.now()+10000;
while(!existsSync('input-listener-ready-'+mode)){if(Date.now()>deadline)throw Error('Input listener did not start');await new Promise(resolve=>setTimeout(resolve,10))}
await new Promise(resolve=>setTimeout(resolve,100));process.stdout.write(new Uint8Array([255,0,240]));
await new Promise(resolve=>setTimeout(resolve,100));process.stdout.write(new Uint8Array([159,152,128]));`,
  '/app/listener-input.js':`import {writeFileSync} from 'node:fs';
let received=0;const mode=process.argv[2]??'data';
const consume=chunk=>{received+=chunk.length;process.stdout.write(chunk)};
if(mode==='readable')process.stdin.on('readable',()=>{let chunk;while((chunk=process.stdin.read())!==null)consume(chunk)});
else process.stdin.on('data',consume);
process.stdin.on('end',()=>writeFileSync('input-listener-ended-'+mode,String(received)));
writeFileSync('input-listener-ready-'+mode,'ready');`,
  '/app/slow-input.js':`import {writeFileSync} from 'node:fs';import {once} from 'node:events';
await new Promise(resolve=>setTimeout(resolve,50));
let received=0,mismatches=0,maxBuffered=process.stdin.readableLength;
for await(const chunk of process.stdin){
  maxBuffered=Math.max(maxBuffered,process.stdin.readableLength);
  for(const byte of chunk){if(byte!==received%65536%251)mismatches++;received++}
  if(!process.stdout.write(chunk))await once(process.stdout,'drain');
  await new Promise(resolve=>setTimeout(resolve,1));
  maxBuffered=Math.max(maxBuffered,process.stdin.readableLength);
}
writeFileSync('stdin-result.json',JSON.stringify({received,mismatches,maxBuffered}));`,
  '/app/worker-burst.js':`import {Worker} from 'node:worker_threads';import {once} from 'node:events';
const child=new Worker(new URL('./burst-probe.js',import.meta.url),{stdout:true});
child.stdout.pipe(process.stdout);const [code]=await once(child,'exit');if(code!==0)throw Error('Worker exit '+code);`,
  '/app/fork-burst.js':`import {fork} from 'node:child_process';import {once} from 'node:events';
const child=fork(new URL('./burst-probe.js',import.meta.url),[],{silent:true});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
const [code]=await once(child,'exit');if(code!==0)throw Error('Fork exit '+code);`,
  '/app/fork-input.js':`import {fork} from 'node:child_process';import {once} from 'node:events';
const child=fork(new URL('./slow-input.js',import.meta.url),[],{silent:true});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
const [code]=await once(child,'exit');if(code!==0)throw Error('Fork exit '+code);`,
}
