import assert from 'node:assert/strict'
import {transformSync,types as t} from '@babel/core'

// Vite already refuses to cache an invalidated transform. Do not send those
// stale bytes to a client either, because import analysis may reference newer
// module versions and an update can precede the first hot-context registration.
export function retryInvalidatedViteClientTransform(source){
  let matches=0
  const result=transformSync(source,{babelrc:false,configFile:false,sourceType:'module',compact:false,plugins:[()=>({visitor:{
    FunctionDeclaration(path){
      if(!t.isIdentifier(path.node.id,{name:'loadAndTransform'}))return
      matches++
      assert.equal(path.node.async,true,'Pinned Vite transform must remain asynchronous')
      assert.deepEqual(path.node.params.map(param=>param.name),['environment','id','url','options','timestamp','mod','resolved'])
      const statements=path.node.body.body
      const cache=statements.at(-2),returned=statements.at(-1)
      assert.ok(t.isReturnStatement(returned)&&t.isIdentifier(returned.argument,{name:'result'}),'Pinned Vite transform result changed')
      assert.ok(t.isIfStatement(cache)&&t.isBinaryExpression(cache.test,{operator:'>'})&&
        t.isIdentifier(cache.test.left,{name:'timestamp'})&&t.isMemberExpression(cache.test.right)&&
        t.isIdentifier(cache.test.right.object,{name:'mod'})&&t.isIdentifier(cache.test.right.property,{name:'lastInvalidationTimestamp'}),
      'Pinned Vite transform cache guard changed')
      const update=cache.consequent
      assert.ok(t.isExpressionStatement(update)&&t.isCallExpression(update.expression)&&
        t.isMemberExpression(update.expression.callee)&&t.isIdentifier(update.expression.callee.object,{name:'moduleGraph'})&&
        t.isIdentifier(update.expression.callee.property,{name:'updateModuleTransformResult'})&&
        update.expression.arguments.length===2&&t.isIdentifier(update.expression.arguments[0],{name:'mod'})&&
        t.isIdentifier(update.expression.arguments[1],{name:'result'}),'Pinned Vite transform cache publication changed')
      assert.ok(!statements.some(statement=>t.isIfStatement(statement)&&t.isReturnStatement(statement.consequent)&&
        t.isCallExpression(statement.consequent.argument)&&t.isIdentifier(statement.consequent.argument.callee,{name:'transformRequest'})),
      'Vite client invalidation retry already applied or upstream transform changed')
      const invalidated=t.binaryExpression('<=',t.identifier('timestamp'),t.memberExpression(t.identifier('mod'),t.identifier('lastInvalidationTimestamp')))
      const client=t.binaryExpression('===',t.memberExpression(t.memberExpression(t.identifier('environment'),t.identifier('config')),t.identifier('consumer')),t.stringLiteral('client'))
      statements.splice(statements.length-2,0,t.ifStatement(t.logicalExpression('&&',invalidated,client),
        t.returnStatement(t.callExpression(t.identifier('transformRequest'),[t.identifier('environment'),t.identifier('url'),t.identifier('options')]))))
      path.skip()
    },
  }})]})
  assert.equal(matches,1,'Expected exactly one pinned Vite loadAndTransform function')
  return result.code
}
