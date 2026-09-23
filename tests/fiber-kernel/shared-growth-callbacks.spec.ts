import {test,expect} from '@playwright/test'

function callbackGrowthCases(){
  const results=[]
  for(const mode of ['set','slice-species','sort','data-view']){
    const memory=new WebAssembly.Memory({initial:1,maximum:4,shared:true})
    const old=memory.buffer,view=new Uint8Array(old,8,8),calls:string[]=[]
    view.set([9,7,5,3,1,2,4,6])
    let grown=false,output:number[]=[]
    // Sort implementations may compare a different number of times. Record
    // the one growth callback, not engine-specific comparison scheduling.
    const grow=(name:string)=>{if(!grown){calls.push(name);memory.grow(1);grown=true}}
    if(mode==='set'){
      view.set([
        {valueOf(){grow('first-value');return 41}},
        {valueOf(){calls.push('second-value');return 42}},
      ] as unknown as number[],2)
    }else if(mode==='slice-species'){
      const constructor={[Symbol.species]:class extends Uint8Array{
        constructor(length:number){grow('species');super(length)}
      }}
      Object.defineProperty(view,'constructor',{value:constructor})
      output=Array.from(view.slice(1,5))
    }else if(mode==='sort'){
      view.sort((a,b)=>{grow('compare');return a-b})
    }else{
      const data=new DataView(old,10,4)
      data.setUint16(1,{valueOf(){grow('data-value');return 0x1234}} as unknown as number,true)
      output=[data.getUint16(1,true)]
    }
    const current=new Uint8Array(memory.buffer,8,8)
    const before=Array.from(current)
    current[7]=84
    results.push({mode,calls,output,grown,oldLength:old.byteLength,newLength:memory.buffer.byteLength,offset:view.byteOffset,before,oldSeesWrite:Array.from(view),current:Array.from(current)})
  }
  return results
}

test('shared WASM growth during typed array and DataView callbacks matches Node',async({page},info)=>{
  const expected=callbackGrowthCases()
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.execute(`console.log(JSON.stringify((${source})()))`,{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },callbackGrowthCases.toString())
  await info.attach('shared-growth-callbacks.json',{body:JSON.stringify({expected,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(expected)
})
