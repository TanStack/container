import {context,transform,stop} from 'esbuild-wasm'
import {readFileSync} from 'node:fs'

const captures=JSON.parse(readFileSync('/start-transforms.json','utf8'))
let revision=0
const ctx=await context({
  entryPoints:['entry'],bundle:true,write:false,format:'esm',
  plugins:[{name:'nested-transform',setup(build){
    build.onResolve({filter:/.*/},args=>({path:args.path,namespace:'virtual'}))
    build.onLoad({filter:/.*/,namespace:'virtual'},async args=>{
      await new Promise(resolve=>setTimeout(resolve,5))
      const source=args.path==='entry'?'import {value} from "dep";console.log(value)':'export const value: number = '+revision
      const result=await transform(source,{loader:'ts'})
      return {contents:result.code,loader:'js'}
    })
  }}],
})
try{
  for(;revision<3;revision++){
    const [built]=await Promise.all([
      ctx.rebuild(),
      ...captures.map(async capture=>{
        const result=await transform(capture.input,capture.options)
        if(!result.code)throw Error('Empty captured transform')
      }),
    ])
    if(!built.outputFiles[0].text.includes('value = '+revision+';')||built.errors.length)throw Error('Incorrect mixed build revision')
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  const result=await transform('const answer: number = 42; console.log(answer)',{loader:'ts'})
  console.log(JSON.stringify({code:result.code,warnings:result.warnings,rounds:revision}))
}finally{await ctx.dispose();stop()}
