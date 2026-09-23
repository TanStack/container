import {test,expect} from '@playwright/test'
import {readFileSync} from 'node:fs'
const manifest=JSON.parse(readFileSync('public/compiler-depth/manifest.json','utf8')) as {rows:{name:string;kind:string;depth:number}[]}
for(const kind of ['block','loop','if','else'])test(`compiler handles deep ${kind} nesting without host recursion`,async({page},info)=>{
  const rows=manifest.rows.filter(row=>row.kind===kind).map(row=>({...row,bytes:[...readFileSync('public/compiler-depth/'+row.name+'.wasm')]}))
  await page.goto('/sandbox.html')
  const results=await page.evaluate(async rows=>{
    const kernel=new window.sandboxLab.WorkerKernel()
    try{
      const output=[]
      for(const row of rows){
        const result=await kernel.execute(`const m=new WebAssembly.Module(new Uint8Array(${JSON.stringify(row.bytes)}));console.log('compiled');
          const instance=new WebAssembly.Instance(m);try{console.log(instance.exports.answer())}catch(e){console.log(e.name)}`,
          {guestWasm:true,maxBytes:64*1024*1024,timeoutMs:10000})
        output.push({name:row.name,depth:row.depth,...result})
      }
      return output
    }finally{kernel.close()}
  },rows)
  await info.attach('compiler-depth.json',{body:JSON.stringify({kind,results}),contentType:'application/json'})
  for(const result of results){
    expect(result.exitCode,result.name+': '+result.stderr).toBe(0)
    // Compilation depth is no longer a host stack limit. Runtime loop frames
    // retain their separate, explicit 256-frame budget.
    expect(result.stdout,result.name).toBe('compiled\n'+(kind==='loop'&&result.depth>256?'RuntimeError':'42')+'\n')
  }
})
