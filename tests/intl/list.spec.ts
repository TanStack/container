import {test,expect} from '@playwright/test'
import {spawnSync} from 'node:child_process'

const source=`
const out=[];for(const [locale,options,values] of [['en',{style:'long',type:'disjunction'},['one','two','three']],['fr',{style:'short',type:'conjunction'},['un','deux']],['ja',{style:'narrow',type:'unit'},['1','2','3']]]){const formatter=new Intl.ListFormat(locale,options);out.push(formatter.format(values),formatter.formatToParts(values),formatter.resolvedOptions(),Object.prototype.toString.call(formatter))}
out.push(Intl.ListFormat.supportedLocalesOf(['en-US','fr','ja'],{localeMatcher:'lookup'}));
for(const operation of [()=>new Intl.ListFormat('en',null),()=>new Intl.ListFormat('en',{type:'invalid'}),()=>new Intl.ListFormat('en').format([1]),()=>Intl.ListFormat.prototype.format.call({},['a'])]){try{operation();out.push('accepted')}catch(error){out.push(error.name)}}
console.log(JSON.stringify(out));`

for(const guestWasm of [false,true])test(`Intl.ListFormat matches Node | WASM ${guestWasm}`,async({page})=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({source,guestWasm})=>{const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source});try{return await kernel.runModule('/main.mjs',{guestWasm})}finally{kernel.close()}},{source,guestWasm})
  expect(result.exitCode,result.stderr).toBe(0);expect(result.stdout).toBe(node.stdout)
})
