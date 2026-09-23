import {test,expect} from '@playwright/test'

for(const guestWasm of [false,true])test(`${guestWasm?'WASM bridge':'default engine'}: recursive calls fail inside the guest and recover`,async({page},info)=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async guestWasm=>{
    const source=`
      import {inspect} from 'node:util';
      const cases={
        direct(){function recurse(){return recurse()}return recurse()},
        mutual(){function first(){return second()}function second(){return first()}return first()},
        getter(){const value={get field(){return value.field}};return value.field},
        callback(){function recurse(){return [1].map(recurse)}return recurse()},
        constructor(){class Recursive{constructor(){new Recursive()}}return new Recursive()},
        generator(){function* recurse(){yield* recurse()}return recurse().next()},
        async async(){async function recurse(){await recurse()}return recurse()},
        eval(){function recurse(){return eval('recurse()')}return recurse()},
        bound(){let fn=()=>42;for(let i=0;i<2048;i++)fn=fn.bind(null);return fn()},
      };
      for(const stride of [1,2,4,8,16]){
        cases['mixed-getter-'+stride]=()=>{const object={get value(){return recurse(stride)}};function recurse(n){return n?1+recurse(n-1):object.value}return recurse(stride)};
        cases['mixed-callback-'+stride]=()=>{function recurse(n){return n?1+recurse(n-1):[1].map(()=>recurse(stride))}return recurse(stride)};
        cases['mixed-constructor-'+stride]=()=>{class Recursive{constructor(){recurse(stride)}}function recurse(n){return n?1+recurse(n-1):new Recursive()}return recurse(stride)};
      }
      const output=[];
      for(const [name,run] of Object.entries(cases)){
        console.error('Recursion case: '+name);
        let caught=0,completed=0;
        for(let repeat=0;repeat<3;repeat++){
          try{const value=await run();if(name!=='bound'||value!==42)throw Error('Unexpected recursive completion');completed++}
          catch(error){if(error.name!=='InternalError'||error.message!=='stack overflow')throw error;caught++}
          if(inspect(new Map([['recovered',42]]))!=="Map(1) { 'recovered' => 42 }")throw Error('Formatting failed after recursion');
          if(await Promise.resolve(42)!==42)throw Error('Async recovery failed');
        }
        output.push({name,caught,completed});
      }
      console.log(JSON.stringify(output));
    `
    const kernel=new window.sandboxLab.WorkerKernel({'/main.mjs':source})
    try{return await kernel.runModule('/main.mjs',{guestWasm,webAPIs:true,maxBytes:64*1024*1024,timeoutMs:30000})}finally{kernel.close()}
  },guestWasm)
  await info.attach('recursion-recovery.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  const outcomes=JSON.parse(result.stdout)
  expect(outcomes).toHaveLength(24)
  for(const outcome of outcomes){
    expect(outcome.caught+outcome.completed).toBe(3)
    if(outcome.name!=='bound')expect(outcome.caught).toBe(3)
  }
})
