import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const body=`
const results=[],timestamp=Date.UTC(2020,5,15,13,4,5,123);
results.push(Intl.getCanonicalLocales(['EN-us','en-US','fr']),Intl.DateTimeFormat.supportedLocalesOf(['en-GB','fr','ja'],{localeMatcher:'lookup'}));
for(const locale of ['en-GB','en-US','fr-FR','ja-JP','ar-EG'])for(const options of [
  {timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'},
  {timeZone:'UTC',hour:'numeric',minute:'2-digit',second:'2-digit',hour12:false,fractionalSecondDigits:3},
  {timeZone:'America/New_York',dateStyle:'long',timeStyle:'short'},
]){
  const formatter=new Intl.DateTimeFormat(locale,options),bound=formatter.format;
  results.push(bound(timestamp),formatter.formatToParts(timestamp),formatter.resolvedOptions());
  results.push(formatter.formatRange(timestamp,timestamp+86400000),formatter.formatRangeToParts(timestamp,timestamp+86400000));
  results.push(bound===formatter.format,formatter instanceof Intl.DateTimeFormat,Object.prototype.toString.call(formatter));
}
const formatter=Intl.DateTimeFormat('en-GB',{timeZone:'UTC',year:'numeric'});
results.push(formatter.format(new Date(timestamp)),formatter.format(String(timestamp)),typeof formatter.format()==='string',formatter.formatToParts().length>0);
const copied=formatter.resolvedOptions();copied.timeZone='Invalid/Zone';results.push(formatter.resolvedOptions().timeZone);
class Child extends Intl.DateTimeFormat{};results.push(new Child('en',{timeZone:'UTC'}).format(0));
for(const operation of [
  ()=>new Intl.DateTimeFormat('en_US'),()=>new Intl.DateTimeFormat('en',{timeZone:'Invalid/Zone'}),
  ()=>new Intl.DateTimeFormat('en',{dateStyle:'short',year:'numeric'}),()=>new Intl.DateTimeFormat('en',null),
  ()=>formatter.format(NaN),()=>formatter.format(Infinity),()=>formatter.format(1n),()=>formatter.format(Symbol()),
  ()=>formatter.formatRange(1,0),()=>formatter.formatRange(undefined,1),
  ()=>Intl.DateTimeFormat.prototype.resolvedOptions.call({}),
  ()=>Intl.DateTimeFormat.prototype.formatToParts.call({},0),
]){try{operation();results.push('accepted')}catch(error){results.push([error.name,error instanceof TypeError,error instanceof RangeError])}}
`

for(const guestWasm of [false,true])for(const webAPIs of [false,true])test(`date-time formatting: wasm=${guestWasm}, webAPIs=${webAPIs}`,async({page},info)=>{
  const oracle=spawnSync(process.execPath,['--input-type=module','-e',body+'console.log(JSON.stringify(results))'],{encoding:'utf8',timeout:10000})
  expect(oracle.status,oracle.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const browser=await page.evaluate(body=>new Function(body+'return results')(),body)
  const result=await page.evaluate(async({body,guestWasm,webAPIs})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':body+'console.log(JSON.stringify(results));'})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs})}finally{kernel.close()}
  },{body,guestWasm,webAPIs})
  await info.attach('intl.json',{body:JSON.stringify({node:JSON.parse(oracle.stdout),browser,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(browser)
})

for(const guestWasm of [false,true])test(`formatter limits and cleanup: wasm=${guestWasm}`,async({page})=>{
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async guestWasm=>{
    const source=`
      const formatters=[];for(let i=0;i<64;i++)formatters.push(new Intl.DateTimeFormat('en',{timeZone:'UTC'}));
      try{new Intl.DateTimeFormat('en');throw Error('Missing limit')}catch(error){if(error.code!=='ERR_RESOURCE_LIMIT')throw error}
      if(typeof globalThis.__intlCall!=='undefined')throw Error('Leaked primitive');
      if(formatters[0].format.constructor('return typeof document')()!=='undefined')throw Error('Host function leaked');
      console.log('done');`
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source}),results=[]
    try{for(let i=0;i<3;i++)results.push(await kernel.runModule('/main.mjs',{guestWasm}));return results}finally{kernel.close()}
  },guestWasm)
  for(const result of results){expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe('done\n')}
})
