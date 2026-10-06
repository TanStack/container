import {transformSync,minifySync} from 'rolldown/utils'

/** Compiler-only client branch selection, loaded when Vite transforms CommonJS. */
export function prepareBrowserCommonJSSource(source:string,id:string,define:Record<string,string>){
  if(!Object.keys(define).some(key=>source.includes(key)))return source
  const transformed=transformSync(id,source,{lang:'js',sourceType:'commonjs',define,tsconfig:false})
  if(transformed.errors.length)throw new Error(`CommonJS define transform failed: ${id}`,{cause:new AggregateError(transformed.errors)})
  // Minify infers CommonJS grammar from the extension, unlike transform's
  // explicit sourceType. Preserve valid top-level CommonJS return statements.
  const simplified=minifySync(id.endsWith('.cjs')?id:id+'.cjs',transformed.code,{
    module:false,mangle:false,sourcemap:false,
    compress:{unused:false,keepNames:{function:true,class:true},dropConsole:false,dropDebugger:false,
      joinVars:false,sequences:false,treeshake:{annotations:false,propertyReadSideEffects:'always',
        propertyWriteSideEffects:true,unknownGlobalSideEffects:true,invalidImportSideEffects:true}},
    codegen:{removeWhitespace:false,legalComments:'inline'},
  })
  if(simplified.errors.length)throw new Error(`CommonJS branch transform failed: ${id}`,{cause:simplified.errors})
  return simplified.code
}
