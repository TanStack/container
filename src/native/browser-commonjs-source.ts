import {transformSync as babelTransform} from '@babel/core'

/** Only literal build values are eligible for early CommonJS branch selection. */
export function browserCommonJSDefines(user:Record<string,unknown>,nodeEnv:string,
  {keepProcessEnv=false}={}){
  const raw:Record<string,unknown>={...user}
  if(!keepProcessEnv){
    const value=Object.hasOwn(user,'process.env.NODE_ENV')?user['process.env.NODE_ENV']:JSON.stringify(nodeEnv)
    for(const key of ['process.env.NODE_ENV','global.process.env.NODE_ENV','globalThis.process.env.NODE_ENV'])
      if(!Object.hasOwn(raw,key))raw[key]=value
  }
  const literals:Record<string,string>={}
  for(const [key,expression]of Object.entries(raw)){
    if(!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(key))continue
    try{
      const value=typeof expression==='string'?JSON.parse(expression):expression
      if(value===null||['string','boolean','number'].includes(typeof value))
        if(typeof value!=='number'||Number.isFinite(value))literals[key]=JSON.stringify(value)
    }catch{/* Vite still owns non-literal expressions, do not guess their value. */}
  }
  return literals
}

export function browserCommonJSDependencies(source:string,id:string){
  const dependencies=new Set<string>()
  babelTransform(source,{babelrc:false,configFile:false,sourceType:'script',filename:id,
    parserOpts:{allowReturnOutsideFunction:true},plugins:[()=>({visitor:{CallExpression(path:any){
      const call=path.node
      if(call.callee.type==='Identifier'&&call.callee.name==='require'&&
        call.arguments.length===1&&call.arguments[0]?.type==='StringLiteral'&&
        !path.scope.hasBinding('require'))dependencies.add(call.arguments[0].value)
    }}})]})
  return [...dependencies]
}
