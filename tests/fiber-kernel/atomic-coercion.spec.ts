import {test,expect} from '@playwright/test'

function coercionCases(){
  const results=[]
  for(const operation of ['add','exchange','compareExchange','store','wait','notify']){
    const memory=new WebAssembly.Memory({initial:1,maximum:3,shared:true})
    const old=memory.buffer,view=new Int32Array(old),order:string[]=[]
    view[0]=7
    let grown=false
    const operand=(name:string,value:number,grow=false)=>({valueOf(){
      order.push(name)
      if(grow){if(grown)throw Error('Repeated growth coercion');grown=true;memory.grow(1)}
      return value
    }})
    const index=operand('index',0)
    let returned:number|string
    if(operation==='add')returned=Atomics.add(view,index as unknown as number,operand('value',5,true) as unknown as number)
    else if(operation==='exchange')returned=Atomics.exchange(view,index as unknown as number,operand('value',11,true) as unknown as number)
    else if(operation==='compareExchange')returned=Atomics.compareExchange(view,index as unknown as number,operand('expected',7) as unknown as number,operand('replacement',13,true) as unknown as number)
    else if(operation==='store')returned=Atomics.store(view,index as unknown as number,operand('value',17,true) as unknown as number)
    else if(operation==='wait')returned=Atomics.wait(view,index as unknown as number,operand('expected',7) as unknown as number,operand('timeout',0,true) as unknown as number)
    else returned=Atomics.notify(view,index as unknown as number,operand('count',1,true) as unknown as number)
    const current=new Int32Array(memory.buffer)
    const afterOperation=current[0]
    current[0]+=1
    results.push({operation,order,returned,afterOperation,oldSeesWrite:view[0],oldLength:old.byteLength,newLength:memory.buffer.byteLength,grown})
  }
  return results
}

test('atomic argument coercions may grow shared WASM memory without stale views',async({page},info)=>{
  const expected=coercionCases()
  expect(expected.map(value=>value.order)).toEqual([
    ['index','value'],['index','value'],['index','expected','replacement'],
    ['index','value'],['index','expected','timeout'],['index','count'],
  ])
  expect(expected.map(value=>value.returned)).toEqual([7,7,7,17,'timed-out',0])
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.execute(`console.log(JSON.stringify((${source})()))`,{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },coercionCases.toString())
  await info.attach('atomic-coercion.json',{body:JSON.stringify({expected,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(expected)
})
