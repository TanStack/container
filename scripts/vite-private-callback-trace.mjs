import assert from 'node:assert/strict'
import {transformSync,types as t} from '@babel/core'

export function traceVitePrivateCallback(source) {
  let matches=0
  const result=transformSync(source,{babelrc:false,configFile:false,sourceType:'module',compact:false,plugins:[()=>({visitor:{
    ObjectMethod(path){
      if(!t.isIdentifier(path.node.key,{name:'resolveSubpathImports'}))return
      const original=path.node.body
      assert.equal(path.node.async,false,'Private import callback must remain synchronous')
      assert.deepEqual(path.node.params.map(node=>node.name),['id','importer','isRequire'])
      assert.equal(original.body.length,1,'Pinned private callback shape changed')
      assert.ok(t.isReturnStatement(original.body[0])&&t.isCallExpression(original.body[0].argument)&&
        t.isIdentifier(original.body[0].argument.callee,{name:'resolveSubpathImports'}),'Pinned private callback target changed')
      matches++
      const finish=path.scope.generateUidIdentifier('finishPrivateImport')
      const observer=path.scope.generateUidIdentifier('observePrivateImport')
      const outcome=path.scope.generateUidIdentifier('privateImportOutcome')
      const error=path.scope.generateUidIdentifier('privateImportError')
      const observerKey=t.callExpression(t.memberExpression(t.identifier('Symbol'),t.identifier('for')),
        [t.stringLiteral('web-container:vite-private-callback')])
      path.node.body=t.blockStatement([
        t.variableDeclaration('let',[t.variableDeclarator(finish),t.variableDeclarator(outcome,t.stringLiteral('returned'))]),
        t.tryStatement(t.blockStatement([
          t.variableDeclaration('const',[t.variableDeclarator(observer,t.memberExpression(t.identifier('globalThis'),observerKey,true))]),
          t.ifStatement(t.binaryExpression('===',t.unaryExpression('typeof',observer),t.stringLiteral('function')),
            t.expressionStatement(t.assignmentExpression('=',finish,t.callExpression(observer,[
              t.identifier('id'),t.identifier('importer'),t.memberExpression(t.identifier('partialEnv'),t.identifier('name'))])))),
        ]),t.catchClause(null,t.blockStatement([]))),
        t.tryStatement(original,t.catchClause(error,t.blockStatement([
          t.expressionStatement(t.assignmentExpression('=',outcome,t.stringLiteral('threw'))),t.throwStatement(error),
        ])),t.blockStatement([
          t.tryStatement(t.blockStatement([
            t.ifStatement(t.binaryExpression('===',t.unaryExpression('typeof',finish),t.stringLiteral('function')),
              t.expressionStatement(t.callExpression(finish,[outcome]))),
          ]),t.catchClause(null,t.blockStatement([]))),
        ])),
      ])
      path.skip()
    },
  }})]})
  assert.equal(matches,1,'Expected exactly one pinned Vite private callback')
  return result.code
}
