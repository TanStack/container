import {test,expect} from '@playwright/test'

// A valid standard SIMD instruction in an otherwise unused void function.
// Replace the unsupported-feature assertion when this runtime implements SIMD.
const simdModule=[0,97,115,109,1,0,0,0,
  1,4,1,96,0,0,
  3,2,1,0,
  10,23,1,21,0,253,12,...Array(16).fill(0),26,11,
]
const addModule=[0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]

test('unsupported SIMD reports its function and opcode location then permits ordinary WASM',async({page},info)=>{
  expect(()=>new WebAssembly.Module(new Uint8Array(simdModule))).not.toThrow()
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({simdModule,addModule})=>{
    const kernel=new window.sandboxLab.WorkerKernel({},{experimentalFibers:true,timeoutMs:20000})
    try{return await kernel.execute(`
let failure=null;
try{new WebAssembly.Module(new Uint8Array(${JSON.stringify(simdModule)}))}
catch(error){failure={name:error.name,message:error.message,compileError:error instanceof WebAssembly.CompileError}}
const module=new WebAssembly.Module(new Uint8Array(${JSON.stringify(addModule)}));
console.log(JSON.stringify({failure,recovered:new WebAssembly.Instance(module).exports.add(20,22)}));
`,{guestWasm:true,webAPIs:true,timeoutMs:20000})}finally{kernel.close()}
  },{simdModule,addModule})
  await info.attach('wasm-validation-location.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const parsed=JSON.parse(result.stdout)
  expect(parsed.recovered).toBe(42)
  expect(parsed.failure).toMatchObject({name:'CompileError',compileError:true})
  expect(parsed.failure.message).toMatch(/function\s*0\b/i)
  expect(parsed.failure.message).toMatch(/opcode\s*0xfd\b/i)
  expect(parsed.failure.message).toMatch(/subopcode\s*0xc\b/i)
  expect(parsed.failure.message).toMatch(/body\s*offset\s*\d+\b/i)
})
