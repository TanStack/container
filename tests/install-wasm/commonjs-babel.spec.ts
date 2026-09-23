import {test,expect} from '@playwright/test'
import {readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createRequire} from 'node:module'

const require=createRequire(import.meta.url)
const files:Record<string,string>={}
for(const name of ['@babel/types','@babel/helper-string-parser','@babel/helper-validator-identifier']){
  const root='node_modules/'+name
  const copy=(relative:string)=>{
    for(const entry of readdirSync(join(root,relative),{withFileTypes:true})){
      const path=join(relative,entry.name)
      if(entry.isDirectory())copy(path)
      else if(path.endsWith('.js')||path==='package.json')files['/'+root+'/'+path]=readFileSync(join(root,path),'utf8')
    }
  }
  copy('')
}
const reference=require('@babel/types').identifier('answer')
const spawned=process.env.BABEL_SPAWN==='1'
for(const mode of ['CJS','ESM','dynamic','ESM-chain'])for(const depth of [0,8,16,32])for(const cooperative of [false,true])test(`Babel CommonJS graph loads ${cooperative?'cooperatively':'synchronously'} through ${depth} callers from ${mode}`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({files,cooperative,depth,mode,spawned})=>{
    const nested:Record<string,string>={}
    const extension=mode==='ESM-chain'?'.mjs':'.cjs'
    for(let i=0;i<depth;i++){
      const target=JSON.stringify(i+1===depth?'@babel/types':'./chain'+(i+1)+extension)
      nested['/chain'+i+extension]=mode==='ESM-chain'?`import value from ${target};export default value;`:`module.exports=require(${target})`
    }
    const entry=mode==='CJS'?'/probe.cjs':'/probe.mjs',target=JSON.stringify(depth?'./chain0'+extension:'@babel/types')
    const source=(mode==='dynamic'?`const {default:t}=await import(${target});`:mode!=='CJS'?`import t from ${target};`:`const t=require(${target});`)+`console.log(JSON.stringify(t.identifier('answer')))`
    const kernel=new window.sandboxLab.WorkerKernel({...files,...nested,[entry]:source},{cooperative})
    try{
      if(!spawned)return await kernel.runModule(entry,{guestWasm:true,timeoutMs:15000})
      const child=await kernel.spawn('node',[entry],{guestWasm:true,lifetime:'session',timeoutMs:15000})
      try{const result=await child.wait();while(await child.next()){};return result}
      finally{await child.dispose()}
    }
    finally{kernel.close()}
  },{files,cooperative,depth,mode,spawned})
  await info.attach('commonjs-babel.json',{body:JSON.stringify({cooperative,depth,mode,spawned,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(reference)
})
