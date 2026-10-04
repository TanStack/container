import assert from 'node:assert/strict'
import {parseSync,transformSync,types as t} from '@babel/core'

export function traceWasiFsProxy(source){
  let writers=0,calls=0
  const helper=parseSync(`function observeWasiFsOverflow(sab,payload,operation,replyKind){
    try{globalThis.postMessage({type:'native-dev-progress',phase:'wasi-fs-overflow:'+JSON.stringify({
      method:typeof operation==='string'?operation.slice(0,64):'unknown',reply:replyKind,
      encodedBytes:payload.length,limit:10240,wireType:Atomics.load(sab,1),wireStatus:Atomics.load(sab,0)
    })})}catch{}
  }`,{babelrc:false,configFile:false}).program.body[0]
  const result=transformSync(source,{babelrc:false,configFile:false,sourceType:'module',compact:false,
    plugins:[()=>({visitor:{
      Program:{enter(path){this.observer=path.scope.generateUidIdentifier('observeWasiFsOverflow')},exit(path){
        helper.id=t.cloneNode(this.observer);path.unshiftContainer('body',helper)
      }},
      VariableDeclarator(path){
        if(!t.isIdentifier(path.node.id,{name:'writeResponsePayload'}))return
        const writer=path.node.init
        assert.ok(t.isArrowFunctionExpression(writer)&&t.isBlockStatement(writer.body),'Pinned filesystem writer changed')
        assert.deepEqual(writer.params.map(node=>node.name),['sab','payload'])
        const condition=writer.body.body[0]
        assert.ok(t.isIfStatement(condition)&&t.isBlockStatement(condition.consequent),'Pinned overflow guard changed')
        assert.ok(t.isBinaryExpression(condition.test,{operator:'>'})&&
          t.isMemberExpression(condition.test.left)&&t.isIdentifier(condition.test.left.object,{name:'payload'})&&
          t.isIdentifier(condition.test.left.property,{name:'length'})&&
          t.isIdentifier(condition.test.right,{name:'RESPONSE_PAYLOAD_SIZE'}),'Pinned overflow predicate changed')
        writer.params.push(t.identifier('operation'),t.identifier('replyKind'))
        condition.consequent.body.unshift(t.expressionStatement(t.callExpression(t.cloneNode(this.observer),[
          t.identifier('sab'),t.identifier('payload'),t.identifier('operation'),t.identifier('replyKind')
        ])))
        writers++
      },
      CallExpression(path){
        if(!t.isIdentifier(path.node.callee,{name:'writeResponsePayload'}))return
        assert.deepEqual(path.node.arguments.map(node=>node.name),['sab','v'],'Pinned filesystem reply call changed')
        const error=Boolean(path.findParent(parent=>parent.isCatchClause()))
        path.node.arguments.push(t.identifier('type'),t.stringLiteral(error?'error':'result'));calls++
      },
    }})]})
  assert.equal(writers,1,'Expected exactly one filesystem reply writer')
  assert.equal(calls,2,'Expected result and error filesystem reply calls')
  return result.code
}
