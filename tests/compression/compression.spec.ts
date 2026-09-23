import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'
import {gzipSync,deflateSync,deflateRawSync,gunzipSync,inflateSync,inflateRawSync,brotliCompressSync,brotliDecompressSync} from 'node:zlib'

const cases:Record<string,string>={
  'window sizes and invalid options reject like Node':`
    import z from 'node:zlib';const seen=[];
    for(const ctor of ['Deflate','Gzip','DeflateRaw','Inflate','Gunzip','InflateRaw','Unzip'])for(const windowBits of [0,7,8,9]){try{const stream=new z[ctor]({windowBits});stream.close();seen.push('ok')}catch(error){seen.push(error.code)}}
    for(const options of [{level:10},{memLevel:0},{chunkSize:32},{strategy:5},{maxOutputLength:0}]){try{z.gzipSync('input',options)}catch(error){seen.push(error.code)}}seen.push(z.inflateSync(z.deflateSync('auto window',{windowBits:9}),{windowBits:0}).toString(),z.gunzipSync(z.gzipSync('gzip window'),{windowBits:0}).toString());console.log(JSON.stringify(seen));`,
  'destroying during data delivery completes a write callback once':`
    import z from 'node:zlib';const decoder=z.createGunzip();let writes=0;const events=[];decoder.on('error',error=>events.push(error.code));decoder.on('data',()=>decoder.destroy());const closed=new Promise(resolve=>decoder.on('close',resolve));decoder.write(z.gzipSync('a'.repeat(100000)),()=>writes++);await closed;await new Promise(resolve=>setImmediate(resolve));console.log(JSON.stringify([writes,decoder.destroyed,events]));`,
  'sync formats, binary views, empty payloads and CRC32':`
    import z from 'node:zlib';
    const data=Buffer.from([0,255,128,65,240,159,166,138]),seen=[];
    for(const [pack,unpack] of [['gzipSync','gunzipSync'],['deflateSync','inflateSync'],['deflateRawSync','inflateRawSync']]){
      seen.push(Array.from(z[unpack](z[pack](new DataView(data.buffer,data.byteOffset,data.length)))));seen.push(z[unpack](z[pack]('')).length);
    }
    seen.push(z.crc32('hello'),z.crc32('world',z.crc32('hello')),z.unzipSync(z.gzipSync('auto gzip')).toString(),z.unzipSync(z.deflateSync('auto zlib')).toString());console.log(JSON.stringify(seen));`,
  'async callbacks, promisify and ALS':`
    import z from 'node:zlib';import {promisify} from 'node:util';import {AsyncLocalStorage} from 'node:async_hooks';
    const als=new AsyncLocalStorage(),seen=[];const done=new Promise(resolve=>als.run('compression',()=>z.gzip('hello',(error,bytes)=>{seen.push([error?.code??null,als.getStore(),z.gunzipSync(bytes).toString()]);resolve()})));seen.push('sync');await done;
    const encoded=await promisify(z.deflate)('promise');seen.push((await promisify(z.inflate)(encoded)).toString());console.log(JSON.stringify(seen));`,
  'stream pipeline, slow writes, backpressure and input byte counts':`
    import z from 'node:zlib';import {Readable,Writable} from 'node:stream';import {pipeline} from 'node:stream/promises';
    const input=Buffer.alloc(256*1024,7),gzip=z.createGzip({chunkSize:1024}),gunzip=z.createGunzip({chunkSize:1024});let count=0,sum=0;
    await pipeline(Readable.from([input.subarray(0,1000),input.subarray(1000)]),gzip,gunzip,new Writable({highWaterMark:1024,write(bytes,encoding,done){count+=bytes.length;for(const byte of bytes)sum+=byte;setImmediate(done)}}));
    console.log(JSON.stringify([count,sum,gzip.bytesWritten,gunzip.destroyed,gzip.destroyed]));`,
  'dictionary, missing dictionary and concatenated gzip members':`
    import z from 'node:zlib';const dictionary=Buffer.from('shared prefix shared prefix'),payload=Buffer.from('shared prefix and tail');const packed=z.deflateSync(payload,{dictionary});
    let missing;try{z.inflateSync(packed)}catch(error){missing=error.code}
    console.log(JSON.stringify([z.inflateSync(packed,{dictionary}).toString(),missing,z.gunzipSync(Buffer.concat([z.gzipSync('first'),z.gzipSync('second')])).toString()]));`,
  'sync flush exposes partial output and permits more writes':`
    import z from 'node:zlib';
    const encoder=z.createDeflateRaw({chunkSize:64}),chunks=[];encoder.on('data',chunk=>chunks.push(chunk));encoder.write('first');await new Promise(resolve=>encoder.flush(z.constants.Z_SYNC_FLUSH,resolve));
    const prefix=Buffer.concat(chunks),partial=z.inflateRawSync(prefix,{finishFlush:z.constants.Z_SYNC_FLUSH}).toString();const done=new Promise(resolve=>encoder.on('end',resolve));encoder.end('second');await done;
    console.log(JSON.stringify([partial,z.inflateRawSync(Buffer.concat(chunks)).toString(),encoder.bytesWritten]));`,
  'malformed input, truncated input and maxOutputLength fail with recovery':`
    import z from 'node:zlib';import {promisify} from 'node:util';const encoded=z.gzipSync('a'.repeat(10000)),seen=[];
    for(const input of [Buffer.from('not gzip'),encoded.subarray(0,encoded.length-3)]){try{z.gunzipSync(input)}catch(error){seen.push(error.code)}}
    try{z.gunzipSync(encoded,{maxOutputLength:100})}catch(error){seen.push(error.code)}
    try{await promisify(z.gunzip)(encoded,{maxOutputLength:100})}catch(error){seen.push(error.code)}
    seen.push(z.gunzipSync(z.gzipSync('recovered')).toString());console.log(JSON.stringify(seen));`,
  'info returns input byte counts and buffers':`
    import z from 'node:zlib';import {promisify} from 'node:util';const packed=z.gzipSync('abcdef',{info:true});const unpacked=await promisify(z.gunzip)(packed.buffer,{info:true});
    console.log(JSON.stringify([packed.engine.bytesWritten,packed.engine instanceof z.Gzip,packed.engine._closed,unpacked.engine instanceof z.Gunzip,unpacked.buffer.toString(),unpacked.engine.bytesWritten===packed.buffer.length]));`,
  'stream errors and close callbacks settle once':`
    import z from 'node:zlib';const stream=z.createGunzip(),events=[];stream.on('error',error=>events.push(error.code));stream.on('close',()=>events.push('close'));const done=new Promise(resolve=>stream.on('close',resolve));stream.resume();stream.end('broken');await done;
    const encoder=z.createGzip();await new Promise(resolve=>encoder.close(resolve));console.log(JSON.stringify([events,encoder.destroyed,encoder.closed]));`,
  'Brotli sync, callback, streams, constants and named exports':`
    import z,{createBrotliCompress,createBrotliDecompress,brotliCompressSync,brotliDecompressSync,BrotliCompress,BrotliDecompress,constants} from 'node:zlib';import {promisify} from 'node:util';import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';
    const input='brotli payload 🦊 '.repeat(200),sync=brotliCompressSync(input),callback=await promisify(z.brotliCompress)(input),chunks=[];
    await pipeline(Readable.from([input.slice(0,100),input.slice(100)]),createBrotliCompress(),createBrotliDecompress(),async function*(source){for await(const chunk of source){chunks.push(chunk);yield chunk}});
    console.log(JSON.stringify([brotliDecompressSync(sync).toString(),z.brotliDecompressSync(callback).toString(),Buffer.concat(chunks).toString(),createBrotliCompress() instanceof BrotliCompress,createBrotliDecompress() instanceof BrotliDecompress,constants.BROTLI_PARAM_QUALITY,z.constants.BROTLI_OPERATION_FINISH]));`,
}
for(const guestWasm of [false,true])for(const [name,source] of Object.entries(cases))if(guestWasm||!name.startsWith('Brotli '))test(`${name} | WASM ${guestWasm}`,async({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:15000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm,name})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source},{maxBytes:name.startsWith('Brotli ')?256*1024*1024:64*1024*1024})
    try{return await kernel.runModule('/main.mjs',{guestWasm,timeoutMs:30000,maxBytes:name.startsWith('Brotli ')?256*1024*1024:64*1024*1024})}finally{kernel.close()}
  },{source,guestWasm,name})
  await info.attach('compression.json',{body:JSON.stringify({node:node.stdout,nodeVersion:process.version,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(node.stdout)
})

test('Node and guest compression cross-decode actual bytes',async({page})=>{
  const input=Buffer.from('Interoperable bytes 🦊\0'.repeat(500)),packed=[gzipSync(input),deflateSync(input),deflateRawSync(input)].map(bytes=>bytes.toString('base64'))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({packed,text})=>{
    const source=`import z from 'node:zlib';const encoded=${JSON.stringify(packed)},text=${JSON.stringify(text)};console.log(JSON.stringify({decoded:encoded.map((value,index)=>z[['gunzipSync','inflateSync','inflateRawSync'][index]](Buffer.from(value,'base64')).toString()),encoded:['gzipSync','deflateSync','deflateRawSync'].map(name=>z[name](text).toString('base64'))}));`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source},{maxBytes:256*1024*1024});try{return await kernel.runModule('/main.mjs',{guestWasm:true,timeoutMs:30000,maxBytes:256*1024*1024})}finally{kernel.close()}
  },{packed,text:input.toString()})
  expect(result.exitCode,result.stderr).toBe(0);const output=JSON.parse(result.stdout)
  expect(output.decoded).toEqual([input.toString(),input.toString(),input.toString()])
  for(const [index,decode] of [gunzipSync,inflateSync,inflateRawSync].entries())expect(decode(Buffer.from(output.encoded[index],'base64'))).toEqual(input)
})

test('Node and guest Brotli cross-decode actual bytes',async({page})=>{
  const input=Buffer.from('brotli payload 🦊 '.repeat(200)),packed=brotliCompressSync(input).toString('base64')
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({packed,text})=>{
    const run=async(source:string)=>{const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source},{maxBytes:256*1024*1024});try{return await kernel.runModule('/main.mjs',{guestWasm:true,timeoutMs:30000,maxBytes:256*1024*1024})}finally{kernel.close()}}
    const decoded=await run(`import z from 'node:zlib';console.log(z.brotliDecompressSync(Buffer.from(${JSON.stringify(packed)},'base64')).toString());`)
    const encoded=await run(`import z from 'node:zlib';console.log(z.brotliCompressSync(${JSON.stringify(text)}).toString('base64'));`)
    return {decoded,encoded}
  },{packed,text:input.toString()})
  expect(result.decoded.exitCode,result.decoded.stderr).toBe(0);expect(result.decoded.stdout).toBe(input.toString()+'\n')
  expect(result.encoded.exitCode,result.encoded.stderr).toBe(0);expect(brotliDecompressSync(Buffer.from(result.encoded.stdout.trim(),'base64'))).toEqual(input)
})

for(const guestWasm of [false,true])test(`decompression respects guest memory and recovers | WASM ${guestWasm}`,async({page})=>{
  const compressed=gzipSync(Buffer.alloc(32*1024*1024,65)).toString('base64')
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({compressed,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/keep':'saved','/large.mjs':`import z from 'node:zlib';console.log(z.gunzipSync(Buffer.from(${JSON.stringify(compressed)},'base64')).length)`,
      '/small.mjs':`import z from 'node:zlib';console.log(z.gunzipSync(z.gzipSync('healthy')).toString())`})
    const options={guestWasm,maxBytes:8*1024*1024,timeoutMs:10000,diagnostics:true}
    try{return {before:await kernel.runModule('/small.mjs',options),limited:await kernel.runModule('/large.mjs',options),after:await kernel.runModule('/small.mjs',options),text:await kernel.readText('/keep')}}finally{kernel.close()}
  },{compressed,guestWasm})
  expect(result.before.exitCode,result.before.stderr).toBe(0)
  expect(result.limited.exitCode).toBe(1);expect(result.limited.stdout).toBe('');expect(result.limited.stderr).toMatch(/memory|null/i)
  expect(result.after.exitCode,result.after.stderr).toBe(0);expect(result.after.stdout).toBe('healthy\n');expect(result.text).toBe('saved')
})
