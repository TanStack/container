import ts from 'typescript'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,relative} from 'node:path'

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
const clean=text=>text.replace(/\r\n/g,'\n').replace(/[ \t]+$/gm,'').trim()+'\n'

/** Build a deterministic, package-relative contract from the emitted public declarations. */
export function buildSDKAPIContract(directory,declarations,{requireCompatibility=false,internalStaging=false}={}){
  const root=resolve(directory),files=declarations.files.map(path=>path.replaceAll('\\','/')).sort()
  const program=ts.createProgram(files.map(path=>resolve(root,path)),{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
    strict:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts'],
  })
  const checker=program.getTypeChecker()
  const packageDeclarations=nodes=>(nodes??[]).filter(node=>{
    const file=resolve(node.getSourceFile().fileName)
    return file===root||file.startsWith(root+'/')
  }).map(node=>{
    const file=node.getSourceFile(),path=relative(root,file.fileName).replaceAll('\\','/')
    return {path,text:clean(node.getText(file))}
  }).sort((a,b)=>a.path.localeCompare(b.path)||a.text.localeCompare(b.text))
  const publicMember=symbol=>!(symbol.declarations??[]).some(node=>
    ts.isPrivateIdentifier(node.name??{})||Boolean(ts.getCombinedModifierFlags(node)&(ts.ModifierFlags.Private|ts.ModifierFlags.Protected)))
  const typeText=(type,node)=>checker.typeToString(type,node,ts.TypeFormatFlags.NoTruncation).replaceAll(root.replaceAll('\\','/')+'/', '')
  function inheritedAPI(symbol){
    const owner=symbol.declarations?.find(ts.isClassDeclaration)
    if(!owner?.heritageClauses?.some(clause=>clause.token===ts.SyntaxKind.ExtendsKeyword))return {}
    const members=[]
    for(const [side,type] of [['instance',checker.getDeclaredTypeOfSymbol(symbol)],['static',checker.getTypeOfSymbolAtLocation(symbol,owner)]]){
      for(const member of checker.getPropertiesOfType(type)){
        const nodes=member.declarations??[]
        if(!nodes.length||nodes.some(node=>node.parent===owner)||!publicMember(member))continue
        members.push({name:member.getName(),side,type:typeText(checker.getTypeOfSymbolAtLocation(member,owner),owner),declarations:packageDeclarations(nodes)})
      }
    }
    members.sort((a,b)=>a.side.localeCompare(b.side)||a.name.localeCompare(b.name))
    const inherited={inheritedMembers:members}
    if(!owner.members.some(ts.isConstructorDeclaration)){
      inherited.inheritedConstructors=checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol,owner),ts.SignatureKind.Construct)
        .map(signature=>checker.signatureToString(signature,owner,ts.TypeFormatFlags.NoTruncation).replaceAll(root.replaceAll('\\','/')+'/', ''))
    }
    return inherited
  }
  function inspect(entry){
  const source=program.getSourceFile(resolve(root,entry))
  if(!source)throw Error('Missing SDK API entry declaration: '+entry)
  const module=checker.getSymbolAtLocation(source)
  if(!module)throw Error('SDK API entry is not a module: '+entry)
  return checker.getExportsOfModule(module).map(symbol=>{
    const target=symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol
    const declarations=packageDeclarations(target.declarations)
    return {name:symbol.getName(),flags:target.flags,declarations,...inheritedAPI(target)}
  }).sort((a,b)=>a.name.localeCompare(b.name))
  }
  const entrypoints={'.':{types:declarations.entry,exports:inspect(declarations.entry)},'./assets':{types:declarations.assetsEntry,exports:inspect(declarations.assetsEntry)}}
  const entrySource=program.getSourceFile(resolve(root,declarations.entry)),entryModule=checker.getSymbolAtLocation(entrySource)
  const compatibilityExport=checker.getExportsOfModule(entryModule).find(symbol=>symbol.getName()==='SDK_COMPATIBILITY')
  if(requireCompatibility&&!compatibilityExport)throw Error('SDK API entry must export SDK_COMPATIBILITY')
  const compatibilitySymbol=compatibilityExport&&(compatibilityExport.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(compatibilityExport):compatibilityExport)
  const compatibilityType=compatibilitySymbol&&checker.getTypeOfSymbolAtLocation(compatibilitySymbol,compatibilitySymbol.valueDeclaration??entrySource)
  const literal=(name,flag)=>{
    const property=checker.getPropertyOfType(compatibilityType,name)
    if(!property)throw Error(`SDK_COMPATIBILITY is missing ${name}`)
    const type=checker.getTypeOfSymbolAtLocation(property,property.valueDeclaration??entrySource)
    if(!(type.flags&flag))throw Error(`SDK_COMPATIBILITY ${name} must be a literal`)
    return type.value
  }
  const apiVersion=compatibilityType?literal('apiVersion',ts.TypeFlags.NumberLiteral):1,stability=compatibilityType?literal('stability',ts.TypeFlags.StringLiteral):'experimental'
  if(!Number.isSafeInteger(apiVersion)||apiVersion<1||stability!=='experimental')throw Error('Invalid SDK_COMPATIBILITY declaration')
  const contract={format:1,...(internalStaging?{scope:'internal-staging'}:{}),apiVersion,stability,entrypoints,declarations:files.map(path=>{
    const bytes=readFileSync(resolve(root,path))
    return {path,bytes:bytes.length,sha256:sha256(bytes)}
  })}
  const path=resolve(root,'api-contract.json'),bytes=Buffer.from(JSON.stringify(contract,null,2)+'\n')
  writeFileSync(path,bytes)
  return {path:'api-contract.json',format:contract.format,apiVersion:contract.apiVersion,stability:contract.stability,sha256:sha256(bytes),exports:Object.fromEntries(Object.entries(entrypoints).map(([name,item])=>[name,item.exports.map(symbol=>symbol.name)]))}
}
