export async function wasmBootstrapDiagnostics(){
  const bytes=new Uint8Array([0,97,115,109,1,0,0,0])
  const result:{available:boolean;isolated:boolean;minimalValid?:boolean;minimalInstantiated?:boolean;error?:string}={
    available:typeof WebAssembly!=='undefined',isolated:globalThis.crossOriginIsolated===true,
  }
  if(!result.available)return result
  try{
    result.minimalValid=WebAssembly.validate(bytes)
    await WebAssembly.instantiate(bytes)
    result.minimalInstantiated=true
  }catch(error){result.error=String(error)}
  return result
}
