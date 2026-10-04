/** Supply browser-backed Function without occupying a module's own scope. */
export function createInlinedModuleFunction(names:string[],code:string,guestFunction:Function):(...values:unknown[])=>Promise<unknown>{
  const factory=new Function('Function',`return async function(${names.join(',')}){\n"use strict";\n${code}\n}`)
  return factory(guestFunction)
}
