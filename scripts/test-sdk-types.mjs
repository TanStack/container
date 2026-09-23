import ts from 'typescript'
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,cpSync,readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {buildSDKTypes} from './build-sdk-types.mjs'

// Deliberately outside the repository, without its Vite, Vitest or Node ambient types.
const root=mkdtempSync(join(tmpdir(),'browser-sandbox-types-consumer-'))
const packageDir=join(root,'node_modules/@tanstack/browser-sandbox-experimental')
mkdirSync(packageDir,{recursive:true})
let result
if(process.argv[2]){
  const built=resolve(process.argv[2])
  cpSync(join(built,'types'),join(packageDir,'types'),{recursive:true,errorOnExist:true,force:false})
  copyFileSync(join(built,'package.json'),join(packageDir,'package.json'))
  const manifest=JSON.parse(readFileSync(join(built,'manifest.json'),'utf8'))
  result={files:manifest.files.filter(file=>file.path.endsWith('.d.ts'))}
}else{
  result=buildSDKTypes(packageDir)
  writeFileSync(join(packageDir,'package.json'),JSON.stringify({type:'module',types:result.entry,exports:{'.':{types:result.entry,import:'./index.js'},'./assets':{types:result.assetsEntry,node:'./assets.mjs'}}}))
}
writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}))
copyFileSync('tests/fixtures/sdk-types-consumer.ts.txt',join(root,'consumer.ts'))
copyFileSync('tests/fixtures/sdk-assets-types-consumer.ts.txt',join(root,'assets-consumer.ts'))
for(const [name,module,moduleResolution] of [
  ['bundler',ts.ModuleKind.ESNext,ts.ModuleResolutionKind.Bundler],
  ['nodenext',ts.ModuleKind.NodeNext,ts.ModuleResolutionKind.NodeNext],
]){
  for(const [fixture,lib] of [
    ['consumer.ts',['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts']],
    ['assets-consumer.ts',['lib.es2022.d.ts']],
  ]){
  const program=ts.createProgram([join(root,fixture)],{
    target:ts.ScriptTarget.ES2022,module,moduleResolution,strict:true,noEmit:true,skipLibCheck:false,
    types:[],lib,
  })
  const diagnostics=ts.getPreEmitDiagnostics(program)
  if(diagnostics.length)throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{
    getCanonicalFileName:file=>file,getCurrentDirectory:()=>root,getNewLine:()=> '\n',
  }))
  const leaked=program.getSourceFiles().filter(file=>file.fileName.startsWith(resolve('src')+'/'))
  if(leaked.length)throw Error('Consumer typecheck read repository source')
  console.log(name+' '+fixture+': passed with skipLibCheck=false and no ambient package types')
  }
}
console.log('SDK_TYPES_CONSUMER='+root)
console.log('SDK_DECLARATION_FILES='+result.files.length)
