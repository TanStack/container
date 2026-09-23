import {test,expect} from '@playwright/test'
const body=`(()=>{
  const out=[];
  for(const locale of ['en-US','de-DE','ar-EG','hi-IN'])for(const options of [{minimumFractionDigits:2,maximumFractionDigits:2},{style:'currency',currency:'USD'},{style:'unit',unit:'kilometer-per-hour'},{notation:'compact'},{signDisplay:'always',useGrouping:false}]){
    const f=new Intl.NumberFormat(locale,options);
    out.push([f.format===f.format,f.resolvedOptions(),[-0,NaN,Infinity,-Infinity,12345.678,9007199254740993n,'9007199254740993.125',undefined,null].map(x=>[f.format(x),f.formatToParts(x)])]);
  }
  const f=Intl.NumberFormat('en');out.push([f.formatRange(1,5),f.formatRangeToParts(1,5),f.format({valueOf(){return 42}})]);
  for(const fn of [()=>new Intl.NumberFormat('en',{style:'currency'}),()=>f.format(Symbol()),()=>f.formatRange(undefined,2),()=>f.format(Object.create(null)),()=>Intl.NumberFormat.prototype.formatToParts.call({},1)]){try{fn();out.push('accepted')}catch(e){out.push(e.name)}}
  return JSON.stringify(out)
})()`
for(const guestWasm of [false,true])test(`number formatting matches browser Intl: ${guestWasm}`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({body,guestWasm})=>{
    const expected=Function('return '+body)()
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':'console.log('+body+')'})
    try{return {expected,execution:await kernel.runModule('/main.mjs',{guestWasm})}}finally{kernel.close()}
  },{body,guestWasm})
  await info.attach('number.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.execution.exitCode,result.execution.stderr).toBe(0);expect(result.execution.stdout.trim()).toBe(result.expected)
})
