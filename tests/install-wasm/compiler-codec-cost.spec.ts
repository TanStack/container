import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {runInNewContext} from 'node:vm'

const captured=JSON.parse(readFileSync('tests/fixtures/sveltekit-define-transform.json','utf8'))
const main=resolve('fixtures/install-sveltekit-wasm/node_modules/esbuild/lib/main.js')
const implementation=readFileSync(main,'utf8')
const start='// lib/shared/stdio_protocol.ts',end='// lib/shared/uint8array_json_parser.ts'
if(implementation.split(start).length!==2||implementation.split(end).length!==2)throw Error('Unexpected esbuild protocol boundaries')
const protocol=implementation.split(start)[1].split(end)[0]
const native=createRequire(import.meta.url)(main)

test('esbuild response packet codec preserves native bytes and values',async({page},info)=>{
  let transformed:any
  try{transformed=await native.transform(captured.source,captured.options)}finally{native.stop()}
  const reference=runInNewContext(protocol+';({encodePacket})',{TextEncoder,TextDecoder,Uint8Array,Array})
  const packets=[false,true].map(fullMap=>{
    const packet={id:7,isRequest:false,value:{code:transformed.code,map:fullMap?transformed.map:'',errors:[],warnings:[],codeFS:false,mapFS:false}}
    const bytes=reference.encodePacket(packet)
    return {fullMap,packet,sha:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}
  })
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({protocol,packets})=>{
    const kernel=new window.sandboxLab.WorkerKernel({
      '/protocol.mjs':protocol+'\nexport {encodePacket,decodePacket};',
      '/packets.json':JSON.stringify(packets),
      '/probe.mjs':`
        import {encodePacket,decodePacket} from './protocol.mjs';
        import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
        const rows=[];
        for(const sample of JSON.parse(readFileSync('/packets.json','utf8'))){
          for(let index=0;index<7;index++){
            const started=performance.now(),bytes=encodePacket(sample.packet),encoded=performance.now();
            const packet=decodePacket(bytes.subarray(4)),decoded=performance.now();
            if(JSON.stringify(packet)!==JSON.stringify(sample.packet))throw Error('Packet value mismatch');
            if(createHash('sha256').update(bytes).digest('hex')!==sample.sha)throw Error('Packet byte mismatch');
            rows.push({fullMap:sample.fullMap,index,bytes:bytes.length,encodeMs:encoded-started,decodeMs:decoded-encoded});
          }
        }
        console.log(JSON.stringify(rows));
      `,
    },{cooperative:true})
    try{return await kernel.runModule('/probe.mjs',{guestWasm:true,webAPIs:true,timeoutMs:30000})}finally{kernel.close()}
  },{protocol,packets})
  await info.attach('compiler-codec-cost.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toHaveLength(14)
})
