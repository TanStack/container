export function browserModuleSource(names:string[],code:string){
  // Vite's runner maps belong to our location registry, not the browser's
  // module debugger. Keep their lines but avoid decoding the same maps twice.
  const compiledCode=code.replace(/\n\/\/# sourceURL=[^\r\n]*\r?\n\/\/# sourceMappingSource=vite-generated\r?\n\/\/# sourceMappingURL=data:application\/json[^\r\n]*\r?\n?$/,trailer=>trailer.replace(/[^\r\n]/g,''))
  return `export default function(Function,Error){return async function(${names.join(',')}){\n"use strict";\n${compiledCode}\n}}`
}
/** Compile a module with a real browser source URL and a lexical constructor. */
export async function createBrowserModuleFunction(names:string[],code:string,guestFunction:Function,guestError:ErrorConstructor=Error){
  const source=browserModuleSource(names,code)
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
  try{
    const factory=(await loadBrowserVmModule(()=>import(/* @vite-ignore */ url))).default
    const evaluate=factory(guestFunction,guestError) as (...values:unknown[])=>Promise<unknown>
    // The two wrapper lines precede unchanged evaluated code. These positions
    // refer to that code, not to original files before Vite/Babel transforms.
    return {evaluate,url,source,startOffset:2,dispose:()=>URL.revokeObjectURL(url)}
  }catch(error){URL.revokeObjectURL(url);throw error}
}
import {loadBrowserVmModule} from './browser-vm-module'
