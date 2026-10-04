import ts from 'typescript'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve,dirname,relative} from 'node:path'

/** Emit source-derived declarations, shipping only the reachable declaration graph. */
export function buildSDKTypes(out,{entry='src/sdk/index.ts',native=false}={}){
  if(!['src/sdk/index.ts','src/sdk/native.ts'].includes(entry))throw Error('Unknown SDK declaration entry: '+entry)
  const declarationEntry='./types/'+entry.slice('src/'.length).replace(/\.ts$/,'.d.ts')
  const nativeEntry='./types/sdk/native.d.ts'
  const root=resolve('src'),emitted=new Map()
  const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile)
  if(config.error)throw Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'))
  const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd(),{
    declaration:true,emitDeclarationOnly:true,noEmit:false,declarationMap:false,
    rootDir:root,outDir:resolve(out,'types'),
  })
  const program=ts.createProgram([resolve(entry),...(native?[resolve('src/sdk/native.ts')]:[]),...parsed.fileNames.filter(file=>file.endsWith('.d.ts'))],parsed.options)
  const result=program.emit(undefined,(file,text)=>emitted.set(resolve(file),text))
  const diagnostics=[...ts.getPreEmitDiagnostics(program),...result.diagnostics]
  if(diagnostics.length)throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{
    getCanonicalFileName:file=>file,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n',
  }))
  const pending=[resolve(out,declarationEntry),...(native?[resolve(out,nativeEntry)]:[])],visited=new Set()
  while(pending.length){
    const file=pending.pop();if(visited.has(file))continue
    const text=emitted.get(file)
    if(text===undefined)throw Error('Missing SDK declaration: '+file)
    visited.add(file)
    const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true)
    const replacements=[]
    function walk(node){
      const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier:
        ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)?node.argument.literal:undefined
      if(specifier&&ts.isStringLiteral(specifier)){
        const value=specifier.text
        if(!value.startsWith('.')||value.includes('?'))throw Error('External SDK declaration dependency: '+value+' in '+file)
        const direct=resolve(dirname(file),value.replace(/\.js$/,'')+'.d.ts')
        const directory=resolve(dirname(file),value.replace(/\.js$/,''),'index.d.ts')
        const target=emitted.has(direct)?direct:emitted.has(directory)?directory:direct
        if(!target.startsWith(resolve(out,'types')+'/'))throw Error('SDK declaration escapes package: '+target)
        pending.push(target)
        let rewrittenTarget=relative(dirname(file),target).replace(/\.d\.ts$/,'.js')
        if(!rewrittenTarget.startsWith('.'))rewrittenTarget='./'+rewrittenTarget
        replacements.push([specifier.getStart(source)+1,specifier.getEnd()-1,rewrittenTarget])
      }
      ts.forEachChild(node,walk)
    }
    walk(source)
    let rewritten=text
    for(const [start,end,value] of replacements.sort((a,b)=>b[0]-a[0]))rewritten=rewritten.slice(0,start)+value+rewritten.slice(end)
    mkdirSync(dirname(file),{recursive:true});writeFileSync(file,rewritten)
  }
  const assetsFile=resolve(out,'types/sdk/assets.d.ts')
  writeFileSync(assetsFile,readFileSync('src/sdk/assets.d.ts'))
  visited.add(assetsFile)
  return {entry:declarationEntry,...(native?{nativeEntry}:{}),assetsEntry:'./types/sdk/assets.d.ts',files:[...visited].map(file=>relative(out,file)).sort()}
}
