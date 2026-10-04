import {transformSync,types as t} from '@babel/core'

export function transformToolchainDynamicImports(source,loaderPath){
  let changed=false
  const result=transformSync(source,{babelrc:false,configFile:false,sourceType:'module',plugins:[()=>({visitor:{
    Program:{enter(path){this.importer=path.scope.generateUidIdentifier('runtimeImport')},exit(path){
      if(changed)path.unshiftContainer('body',t.importDeclaration([
        t.importSpecifier(this.importer,t.identifier('importRuntimeModule')),
      ],t.stringLiteral(loaderPath)))
    }},
    CallExpression(path){
      if(path.node.callee.type!=='Import'||t.isStringLiteral(path.node.arguments[0]))return
      changed=true
      path.node.callee=t.cloneNode(this.importer)
    },
  }})]})
  return changed?result.code:source
}
