import {test,expect} from '@playwright/test'

for(const invocation of ['direct','call','nested-call','five-arguments']){
  test(`fiber sorting invocation ${invocation}`,async({page})=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async invocation=>{
      const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,timeoutMs:20000})
      const call=invocation==='direct'?'sort()':invocation==='call'?'sort.call(null)':invocation==='five-arguments'?'sort.call({}, {}, ()=>{}, {}, "/main.cjs", "/")':'(function(){return sort.call(null)}).call(null)'
      const code=`function sort(){return ['answer','add'].sort()}console.log(JSON.stringify(${call}))`
      // Exercise the worker's internal setup-only option without adding it to
      // the public SDK surface for this diagnostic.
      const options={guestWasm:true,webAPIs:true,loadModules:true,timeoutMs:20000}
      try{return await kernel.execute(code,options)}finally{kernel.close()}
    },invocation)
    expect(result.exitCode,result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['add','answer'])
  })
}

for(const webAPIs of [false,true])for(const moduleEntry of [false,true,'setup-only'] as const){
  test(`fiber sorting setup, web APIs ${webAPIs}, module entry ${moduleEntry}`,async({page},info)=>{
    await page.goto('/sandbox.html')
    const result=await page.evaluate(async({webAPIs,moduleEntry})=>{
      const code=`console.log(JSON.stringify(['answer','add'].sort()))`
      const kernel=new window.sandboxLab.WorkerKernel({'/main.cjs':code},{experimentalFibers:true,timeoutMs:20000})
      const options={guestWasm:true,webAPIs,timeoutMs:20000,loadModules:moduleEntry==='setup-only'}
      try{return await (moduleEntry===true?kernel.runModule('/main.cjs',options):kernel.execute(code,options))}finally{kernel.close()}
    },{webAPIs,moduleEntry})
    await info.attach('sorting-setup.json',{body:JSON.stringify({webAPIs,moduleEntry,result}),contentType:'application/json'})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['add','answer'])
  })
}

const cases:Array<{name:string;files:Record<string,string>;code:string;expected:Record<string,unknown>}>= [
  {
    name:'numeric custom sorting before require',
    files:{},
    code:`console.log(JSON.stringify({keys:[3,1,2].sort((a,b)=>a-b)}));`,
    expected:{keys:[1,2,3]},
  },
  {
    name:'ordinary sorting before require',
    files:{},
    code:`console.log(JSON.stringify({keys:['answer','add'].sort()}));`,
    expected:{keys:['add','answer']},
  },
  {
    name:'namespace before explicit sorting',
    files:{'/entry.mjs':'export const answer=42;export function add(a,b){return a+b}'},
    code:`const value=require('./entry.mjs');console.log(JSON.stringify({keys:Object.keys(value),answer:value.answer}));`,
    expected:{keys:['add','answer'],answer:42},
  },
  {
    name:'named exports',
    files:{'/entry.mjs':'export const answer=42;export function add(a,b){return a+b}'},
    code:`const value=require('./entry.mjs');console.log(JSON.stringify({keys:Object.keys(value).sort(),answer:value.answer,sum:value.add(2,3),same:value===require('./entry.mjs')}));`,
    expected:{keys:['add','answer'],answer:42,sum:5,same:true},
  },
  {
    name:'named imports and star reexports',
    files:{
      '/leaf.mjs':'export let count=1;export function increment(){count++}',
      '/entry.mjs':`import {count,increment} from './leaf.mjs';export * from './leaf.mjs';export function read(){return count};export function advance(){increment()}`,
    },
    code:`const value=require('./entry.mjs');const before=value.count;value.advance();console.log(JSON.stringify({keys:Object.keys(value).sort(),before,count:value.count,read:value.read(),leaf:require('./leaf.mjs').count}));`,
    expected:{keys:['advance','count','increment','read'],before:1,count:2,read:2,leaf:2},
  },
  {
    name:'default export facade',
    files:{'/entry.mjs':'export default {answer:42};export let count=1;export function increment(){count++}'},
    code:`const value=require('./entry.mjs');value.increment();console.log(JSON.stringify({keys:Object.keys(value).sort(),marker:value.__esModule,answer:value.default.answer,count:value.count,same:value===require('./entry.mjs')}));`,
    expected:{keys:['__esModule','count','default','increment'],marker:true,answer:42,count:2,same:true},
  },
]

for(const guestWasm of [false,true])for(const fixture of cases){
  test(`fiber require ESM ${fixture.name}, guest WASM ${guestWasm}`,async({page},info)=>{
    await page.goto('/sandbox.html')
    const files:Record<string,string>={...fixture.files,'/main.cjs':fixture.code}
    const result=await page.evaluate(async({files,guestWasm})=>{
      const kernel=new window.sandboxLab.WorkerKernel(files,{experimentalFibers:true,timeoutMs:20000})
      try{return await kernel.runModule('/main.cjs',{guestWasm,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
    },{files,guestWasm})
    await info.attach('fiber-require-esm.json',{body:JSON.stringify({guestWasm,result}),contentType:'application/json'})
    expect(result.exitCode,result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(fixture.expected)
  })
}
