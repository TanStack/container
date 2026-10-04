import assert from 'node:assert/strict'
import {transformSync,types as t} from '@babel/core'

// Keep the pinned upstream codecs and constructors. Replace only both endpoints.
export function replaceWasiFsProxy(source,modulePath,{trace=false}={}){
  const replaced=new Set(),codecs=new Set()
  const result=transformSync(source,{babelrc:false,configFile:false,sourceType:'module',compact:false,
    plugins:[()=>({visitor:{
      Program:{enter(path){
        this.host=path.scope.generateUidIdentifier('createWasiFilesystemHost')
        this.client=path.scope.generateUidIdentifier('createWasiFilesystemClient')
        this.trace=path.scope.generateUidIdentifier('traceWasiFilesystemReply')
      },exit(path){
        path.unshiftContainer('body',t.importDeclaration([
          t.importSpecifier(this.host,t.identifier('createWasiFilesystemHost')),
          t.importSpecifier(this.client,t.identifier('createWasiFilesystemClient')),
          ...(trace?[t.importSpecifier(this.trace,t.identifier('traceWasiFilesystemReply'))]:[]),
        ],t.stringLiteral(modulePath)))
      }},
      VariableDeclarator(path){
        if(!t.isIdentifier(path.node.id))return
        const name=path.node.id.name
        if(['getType','encodeValue','decodeValue'].includes(name))codecs.add(name)
        if(!['createOnMessage','createFsProxy'].includes(name))return
        assert.ok(path.parentPath.parentPath.isExportNamedDeclaration(),'Pinned proxy export changed')
        assert.ok(!replaced.has(name),'Duplicate proxy endpoint')
        const factory=path.node.init,host=name==='createOnMessage',parameter=host?'fs':'memfs'
        assert.ok(t.isArrowFunctionExpression(factory),'Pinned proxy factory changed')
        assert.deepEqual(factory.params.map(node=>node.name),[parameter])
        const options=host?[t.objectProperty(t.identifier('getType'),t.identifier('getType'),false,true),
          t.objectProperty(t.identifier('encodeValue'),t.identifier('encodeValue'),false,true),
          ...(trace?[t.objectProperty(t.identifier('onReply'),t.cloneNode(this.trace))]:[])]:
          [t.objectProperty(t.identifier('decodeValue'),t.identifier('decodeValue'),false,true)]
        factory.body=t.callExpression(t.cloneNode(host?this.host:this.client),[t.identifier(parameter),t.objectExpression(options)])
        replaced.add(name)
      },
    }})]})
  assert.deepEqual([...replaced].sort(),['createFsProxy','createOnMessage'],'Both proxy endpoints must be replaced')
  assert.deepEqual([...codecs].sort(),['decodeValue','encodeValue','getType'],'Pinned proxy codecs missing')
  return result.code
}
