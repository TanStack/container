import {transformSync} from '@babel/core'
import MagicString from 'magic-string'

/** Edit completion sites only, leaving nested function source unchanged. */
export function compileSourceCompletion(source:string,filename:string,channelKey:string){
  const output=new MagicString(source)
  let finallyIdentity=0
  const call=(method:string,args='')=>`this[${JSON.stringify(channelKey)}].${method}(${args})`
  const wrapStatement=(path:any)=>{
    while(path.parentPath?.isLabeledStatement())path=path.parentPath
    output.appendLeft(path.node.start,`{${call('reset')};`)
    output.appendRight(path.node.end,'}')
  }
  const wrapExpression=(node:any)=>{
    output.prependLeft(node.start,`(${call('reset')},`)
    output.prependRight(node.end,')')
  }
  const result=transformSync(source,{
    babelrc:false,configFile:false,sourceType:'script',filename,code:false,
    plugins:[()=>({visitor:{
      Function(path:any){path.skip()},
      Class(path:any){path.skip()},
      ExpressionStatement(path:any){
        output.appendLeft(path.node.expression.start,call('set').slice(0,-1)+'(')
        output.prependRight(path.node.expression.end,'))')
      },
      IfStatement(path:any){wrapExpression(path.node.test)},
      SwitchStatement(path:any){wrapExpression(path.node.discriminant)},
      WithStatement(path:any){wrapExpression(path.node.object)},
      'WhileStatement|DoWhileStatement|ForStatement|ForInStatement|ForOfStatement'(path:any){wrapStatement(path)},
      TryStatement(path:any){
        wrapStatement(path)
        if(path.node.handler)output.appendLeft(path.node.handler.body.start+1,`${call('reset')};`)
        if(path.node.finalizer){
          const id=String(++finallyIdentity)
          output.appendLeft(path.node.finalizer.start+1,`${call('save',id)};`)
          output.prependRight(path.node.finalizer.end-1,`;${call('restore',id)};`)
        }
      },
      Program(path:any){
        const directives=path.node.directives
        if(directives.length){
          const last=directives.at(-1)
          output.appendLeft(last.end,`;${call('set',source.slice(last.value.start,last.value.end))};`)
        }
      },
    }})],
  })!
  return {...result,code:output.toString(),map:JSON.parse(output.generateMap({source:filename,includeContent:true,hires:true}).toString())}
}
