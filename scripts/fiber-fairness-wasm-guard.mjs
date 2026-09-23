export function runWasmFairnessGuard(engine,bootstrap){
  const check=(value,message)=>{if(!value)throw Error(message)}
  const section=(id,bytes)=>[id,bytes.length,...bytes]
  const bytes=[0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,0,1,0x7f]),
    ...section(2,[1,3,101,110,118,7,99,111,109,112,117,116,101,0,0]),
    ...section(3,[1,0]),...section(7,[1,3,114,117,110,0,1]),
    ...section(10,[1,4,0,0x10,0,0x0b])]
  const compute=()=>{let total=0;for(let i=0;i<1000000;i++)total=(total+(i%97))%1000000007;return total}
  check(WebAssembly.validate(Uint8Array.from(bytes)),'Native validates guard fixture')
  const expected=new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)),{env:{compute}}).exports.run()
  const runtime=engine.newRuntime(),deadline=performance.now()+5000
  runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024);runtime.setInterruptHandler(()=>performance.now()>deadline)
  const context=runtime.newContext();let fiber
  const evaluate=source=>context.unwrapResult(context.evalCode(source))
  try{
    evaluate('globalThis.__webContainerHost={};'+bootstrap).dispose()
    evaluate(`globalThis.compute=${compute.toString()};globalThis.module=new WebAssembly.Module(new Uint8Array(${JSON.stringify(bytes)}));globalThis.instance=new WebAssembly.Instance(module,{env:{compute}})`).dispose()
    fiber=context.startFiberEval('instance.exports.run()','guard.js',0)
    check(fiber.step()===2,'Imported JS must not fairness-yield across WASM')
    const result=fiber.takeResult();try{check(context.getNumber(context.unwrapResult(result))===expected,'WASM import result parity')}finally{result.dispose();fiber.dispose();fiber=undefined}
    fiber=context.startFiberEval('compute()','after-guard.js',0)
    check(fiber.step()===3,'Ordinary JS fairness restored after WASM operation')
    let status=3
    for(let i=0;i<1000&&status===3;i++)status=fiber.step()
    check(status===2,'Finite JS computation completes after guard restoration')
    const after=fiber.takeResult();try{check(context.getNumber(context.unwrapResult(after))===expected,'Post-WASM JS result parity')}finally{after.dispose();fiber.dispose();fiber=undefined}
    return {importedJSNoYield:true,wasmResult:expected,jsFairnessRestored:true}
  }finally{
    if(fiber){fiber.cancel();fiber.step();if(fiber.status()===2)fiber.takeResult().dispose();fiber.dispose()}
    context.dispose();runtime.dispose()
  }
}
