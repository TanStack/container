import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const body=`
import {Buffer} from 'node:buffer';import {createHash,createHmac,randomBytes} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';import {Readable} from 'node:stream';
const results=[];
for(const encoding of ['base64url','BASE64URL','BaSe64UrL']){
  results.push(Buffer.isEncoding(encoding));
  for(let length=0;length<40;length++){
    const bytes=Buffer.alloc(length);for(let i=0;i<length;i++)bytes[i]=(i*73+length*11)%256;
    const encoded=bytes.toString(encoding);results.push(encoded,Buffer.from(encoded,encoding).toString('hex'),Buffer.byteLength(encoded,encoding));
    const written=Buffer.alloc(length+4,95);results.push(written.write(encoded,2,length,encoding),written.toString('hex'));
    results.push(bytes.toString(encoding,1,length-1));
    results.push(Buffer.from(bytes.toString('base64'),encoding).toString('hex'));
  }
}
for(const value of ['-___','+///','Zg','Zg==','Zm8=','Zm9v',' Z m 9 v\\n','a','%%Zm9v!!','','=','==','===','a=','a==','a===','ab=c','😀']){
  results.push(Buffer.from(value,'base64url').toString('hex'),Buffer.byteLength(value,'base64url'),Buffer.byteLength(value,'base64'));
}
results.push(Buffer.alloc(7,'-_8','base64url').toString('hex'));
results.push(createHash('sha256').update('input').digest('base64url'));
results.push(createHmac('sha256','key').update('input').digest('base64url'));
for(const encoding of ['base64','base64url','BASE64URL'])for(let size=1;size<8;size++)for(let length=0;length<15;length++){
  const decoder=new StringDecoder(encoding),bytes=Buffer.alloc(length);for(let i=0;i<length;i++)bytes[i]=(i*73+251)%256;
  const pieces=[];for(let offset=0;offset<length;offset+=size)pieces.push(decoder.write(bytes.subarray(offset,offset+size)));
  pieces.push(decoder.end());results.push(pieces);
}
const stream=Readable.from([Buffer.from([251]),Buffer.from([255,255]),Buffer.from([255])]);
stream.setEncoding('base64url');let streamed='';for await(const chunk of stream)streamed+=chunk;results.push(streamed);
const random=randomBytes(32),encoded=random.toString('base64url');
results.push(Buffer.isBuffer(random),/^[A-Za-z0-9_-]{43}$/.test(encoded),Buffer.from(encoded,'base64url').equals(random));
console.log(JSON.stringify(results));`

for(const guestWasm of [false,true])for(const webAPIs of [false,true])test(`Buffer base64url: wasm=${guestWasm}, webAPIs=${webAPIs}`,async({page},info)=>{
  const oracle=spawnSync(process.execPath,['--input-type=module','-e',body],{encoding:'utf8',timeout:10000,env:{...process.env,FORCE_COLOR:'0'}})
  expect(oracle.status,oracle.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({body,guestWasm,webAPIs})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':body})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs})}finally{kernel.close()}
  },{body,guestWasm,webAPIs})
  await info.attach('base64url.json',{body:JSON.stringify({oracle:oracle.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual(JSON.parse(oracle.stdout))
})
