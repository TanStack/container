type CompilerFilesystem={fs:object;vol:object}
const key=Symbol.for('tanstack-container:compiler-filesystem-v1')
type Scope={ [key:symbol]:unknown }

/** One filesystem provider in each native worker, shared by compiler bundles. */
export function registerCompilerFilesystem(provider:CompilerFilesystem,scope:Scope=globalThis as Scope):CompilerFilesystem{
  const previous=scope[key] as CompilerFilesystem|undefined
  if(previous){
    if(previous.fs!==provider.fs||previous.vol!==provider.vol)
      throw Error('The native worker already owns a different compiler filesystem')
    return previous
  }
  if(!provider.fs||!provider.vol)throw TypeError('A compiler filesystem requires fs and vol')
  const installed=Object.freeze({fs:provider.fs,vol:provider.vol})
  Object.defineProperty(scope,key,{value:installed,configurable:false,writable:false})
  return installed
}

export function getCompilerFilesystem(scope:Scope=globalThis as Scope):CompilerFilesystem{
  const provider=scope[key] as CompilerFilesystem|undefined
  if(!provider)throw Error('The native compiler filesystem has not been registered')
  return provider
}
