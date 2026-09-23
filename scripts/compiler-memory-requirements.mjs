import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import ts from 'typescript'
import {kernelLimits} from '../src/sandbox/kernel-limits.ts'

// Read constructor declarations, never execute package initialization or allocate
// the declared memory. Nonliteral descriptors need a separate runtime check.
const fixtures=[
  ['fixtures/compiler-wasi','@rolldown/binding-wasm32-wasi','rolldown-binding.wasi.cjs'],
  ['fixtures/compiler-wasi-astro','@astrojs/compiler-binding-wasm32-wasi','astro.wasi.cjs'],
]
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const enginePath='public/quickjs-als-asyncify-wasm-atomics-fibers-shared-storage/build.json'
const engineBytes=readFileSync(enginePath),engine=JSON.parse(engineBytes)
const cases=fixtures.map(([root,name,entry])=>{
  const directory=root+'/node_modules/'+name,path=directory+'/'+entry,source=readFileSync(path)
  const ast=ts.createSourceFile(path,source.toString(),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  const declarations=[]
  function visit(node){
    if(ts.isNewExpression(node)&&node.expression.getText(ast)==='WebAssembly.Memory'){
      const descriptor=node.arguments?.[0]
      if(!descriptor||!ts.isObjectLiteralExpression(descriptor))throw Error('Nonliteral memory descriptor in '+path)
      const fields={}
      for(const property of descriptor.properties){
        if(!ts.isPropertyAssignment(property))throw Error('Unsupported memory descriptor property')
        const name=property.name.getText(ast),value=property.initializer
        if(ts.isNumericLiteral(value))fields[name]=Number(value.text)
        else if(value.kind===ts.SyntaxKind.TrueKeyword)fields[name]=true
        else if(value.kind===ts.SyntaxKind.FalseKeyword)fields[name]=false
        else throw Error('Nonliteral memory descriptor value in '+path)
      }
      if(!Number.isInteger(fields.initial)||!Number.isInteger(fields.maximum)||fields.shared!==true)throw Error('Unexpected compiler memory descriptor')
      const initialBytes=fields.initial*65536,maximumBytes=fields.maximum*65536
      let acceptedAsExecutionBudget=true
      try{kernelLimits({maxBytes:initialBytes})}catch{acceptedAsExecutionBudget=false}
      declarations.push({...fields,initialBytes,maximumBytes,
        line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,
        initialFitsSharedPool:initialBytes<=engine.sharedStorage.maxBytes,
        maximumFitsSharedPool:maximumBytes<=engine.sharedStorage.maxBytes,
        acceptedAsExecutionBudget,
      })
    }
    ts.forEachChild(node,visit)
  }
  visit(ast)
  if(declarations.length!==1)throw Error('Expected one memory constructor in '+path)
  return {name,version:JSON.parse(readFileSync(directory+'/package.json')).version,path,
    sourceSHA256:hash(source),lockSHA256:hash(readFileSync(root+'/package-lock.json')),declarations}
})
const report={scope:'Static constructor requirements, not allocation or compiler execution evidence.',
  engineMetadataSHA256:hash(engineBytes),sharedPoolBytes:engine.sharedStorage.maxBytes,
  accounting:'Shared storage is group-accounted, separate from the per-runtime execution budget. Fit checks exclude allocation headers and other live allocations.',cases}
writeFileSync('reports/compiler-memory-requirements.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
