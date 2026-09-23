import {simdFixtures} from './wasm-simd-fixtures.mjs'

export function runSIMDFixtures(engine,fixtures,bootstrap){
  const rows=[]
  const cases=simdFixtures.map(({name,run,expected})=>{
    if(JSON.stringify(run(WebAssembly,fixtures[name]))!==JSON.stringify(expected))throw Error('Native reference differs: '+name)
    return {name,expected,code:`JSON.stringify((${run.toString()})(WebAssembly,${JSON.stringify(Array.from(fixtures[name]))}))`}
  })
  cases.push(...(fixtures.scalar??[]))
  for(const {name,expected,code} of cases){
    const runtime=engine.newRuntime()
    runtime.setMemoryLimit(16*1024*1024)
    runtime.setMaxStackSize(256*1024)
    const deadline=Date.now()+5000
    runtime.setInterruptHandler(()=>Date.now()>deadline)
    const context=runtime.newContext()
    try{
      const result=context.evalCode(bootstrap+';'+code)
      try{
        if(result.error)throw Error(name+': '+JSON.stringify(context.dump(result.error)))
        const actual=JSON.parse(context.getString(result.value))
        if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error(name+': '+JSON.stringify({actual,expected}))
        rows.push({name,actual,expected,passed:true})
      }finally{result.dispose()}
    }finally{context.dispose();runtime.dispose()}
  }
  return rows
}
