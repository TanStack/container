import ts from 'typescript'
import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {builtinModules} from 'node:module'
import {createHash} from 'node:crypto'

const builtinBytes=readFileSync('public/kernel-runtime/builtins.json')
const builtins=JSON.parse(builtinBytes)
const native=new Set(builtinModules.map(name=>'node:'+name.replace(/^node:/,'')))
const references=[],sourceHash=createHash('sha256')
const root='node_modules/vite/dist/node'
for(const file of readdirSync(root,{recursive:true}).filter(file=>file.endsWith('.js')).sort()){
  const path=root+'/'+file,source=readFileSync(path,'utf8')
  sourceHash.update(file+'\0'+source+'\0')
  const tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  function add(value,kind,names,position){
    const id='node:'+value.replace(/^node:/,'')
    if(!native.has(id))return
    const available=builtins.modules[id]
    references.push({file,line:tree.getLineAndCharacterOfPosition(position).line+1,module:id,kind,namedImports:names,
      moduleAvailable:!!available,missingNamedExports:available?names.filter(name=>!available.exports.includes(name)):names})
  }
  function visit(node){
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
      const bindings=node.importClause?.namedBindings
      const names=bindings&&ts.isNamedImports(bindings)?bindings.elements.map(element=>(element.propertyName??element.name).text):[]
      add(node.moduleSpecifier.text,'static',names,node.getStart(tree))
    }else if(ts.isCallExpression(node)&&node.arguments.length===1&&ts.isStringLiteral(node.arguments[0])&&
      (node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&/^(?:require|__require)$/.test(node.expression.text)))){
      add(node.arguments[0].text,'dynamic-or-require',[],node.getStart(tree))
    }
    ts.forEachChild(node,visit)
  }
  visit(tree)
}
const report={scope:'Syntactic Node imports in the locally installed Vite distribution, not its transitive package graph and not proof of runtime behavior or import execution order.',
  viteVersion:JSON.parse(readFileSync('node_modules/vite/package.json')).version,
  sourceSHA256:sourceHash.digest('hex'),builtinsSHA256:createHash('sha256').update(builtinBytes).digest('hex'),
  probeSHA256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),references}
writeFileSync('reports/vite-import-surface.json',JSON.stringify(report,null,2)+'\n')
const gaps=references.filter(item=>!item.moduleAvailable||item.missingNamedExports.length)
console.log(JSON.stringify({viteVersion:report.viteVersion,gaps},null,2))
if(gaps.length)process.exitCode=1
