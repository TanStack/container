export const moduleSourceLimit=8*1024*1024
export const processSourceLimit=32*1024*1024

// Counts the same source reads as the loader, including failed reads of an
// oversized module. Diagnostics do not change admission or retry accounting.
export function createModuleSourceBudget(){
  let loadedBytes=0
  return (path:string,bytes:number)=>{
    if(!Number.isSafeInteger(bytes)||bytes<0)throw new TypeError('Invalid module source byte count')
    loadedBytes+=bytes
    const scope=bytes>moduleSourceLimit?'module':loadedBytes>processSourceLimit?'process':null
    if(scope){
      const observed=scope==='module'?bytes:loadedBytes
      const limit=scope==='module'?moduleSourceLimit:processSourceLimit
      throw Object.assign(new Error(`Runtime module source quota exceeded: ${scope} source bytes ${observed} exceed ${limit} while loading ${JSON.stringify(path)}`),{
        code:'ERR_MODULE_SOURCE_LIMIT',scope,path,observedBytes:observed,limitBytes:limit,
      })
    }
  }
}
