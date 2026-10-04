import {transformSync} from '@babel/core'
import MagicString from 'magic-string'

/** Only calls in result position can discard their caller's frame. */
function hasTailCall(node:any):boolean{
  switch(node.type){
    case 'CallExpression':case 'OptionalCallExpression':case 'TaggedTemplateExpression':return true
    case 'ConditionalExpression':return hasTailCall(node.consequent)||hasTailCall(node.alternate)
    case 'LogicalExpression':return hasTailCall(node.right)
    case 'SequenceExpression':return hasTailCall(node.expressions.at(-1))
    case 'ParenthesizedExpression':return hasTailCall(node.expression)
    default:return false
  }
}

/** Node keeps caller frames, even when the browser supports proper tail calls. */
export function transformNodeReturns(source:string,filename:string,moduleExpression=false){
  let asyncModule=false
  let asyncName='',asyncLength=0
  const output=new MagicString(source)
  const result=transformSync(source,{
    babelrc:false,configFile:false,sourceType:'script',filename,
    code:false,
    plugins:[({types:t}:any)=>({visitor:{
      Program:{exit(path:any){
        if(!moduleExpression||path.node.body.length!==1)return
        const statement=path.node.body[0]
        if(!t.isExpressionStatement(statement))return
        const expression=statement.expression
        if(!(t.isArrowFunctionExpression(expression)||t.isFunctionExpression(expression))||!expression.async||expression.generator)return
        asyncModule=true
        let freeArguments=false
        path.traverse({ReferencedIdentifier(reference:any){
          if(reference.node.name==='arguments'&&!reference.scope.hasBinding('arguments'))freeArguments=true
        }})
        if(freeArguments){asyncModule=false;return}
        asyncName=expression.id?.name??''
        const firstOptional=expression.params.findIndex((parameter:any)=>t.isAssignmentPattern(parameter)||t.isRestElement(parameter))
        asyncLength=firstOptional<0?expression.params.length:firstOptional
        output.prependLeft(statement.start,'export default (function(){return (')
        if(source[statement.end-1]===';')output.remove(statement.end-1,statement.end)
        output.appendRight(statement.end,');}).call(globalThis);')
      }},
      ArrowFunctionExpression(path:any){
        if(t.isBlockStatement(path.node.body))return
        const body=path.node.body
        if(!hasTailCall(body))return
        const start=body.extra?.parenthesized?body.extra.parenStart:body.start
        output.appendLeft(start,'{try{return (')
        output.prependRight(path.node.end,');}finally{}}')
      },
      ReturnStatement:{exit(path:any){
        const argument=path.node.argument
        if(!argument||!hasTailCall(argument))return
        // A finally clause prevents tail calls without adding a lexical binding.
        // Local edits preserve all source outside the protected return.
        output.appendLeft(path.node.start,'try{')
        output.appendRight(path.node.end,';}finally{}')
      }},
    }})],
  })!
  return {...result,code:output.toString(),map:JSON.parse(output.generateMap({source:filename,includeContent:true,hires:true}).toString()),asyncModule,asyncName,asyncLength}
}
