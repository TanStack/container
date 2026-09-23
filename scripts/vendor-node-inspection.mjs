import ts from 'typescript'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

const hashes={
  'internal/util/inspect':'4df57a8b8c0a2db3fdd448a3fc8452ec1e93362287ff1cb1f573880b8d4e3b37',
  'internal/per_context/primordials':'6c9fc969aabdb7403f89eb44545a5aa0e90bec8385c71d4b2f70f54a0a8591f8',
  'internal/util':'a6a3fed1d2de1050cb8b119a2d792246e37abdea4099d90d6994d894f506c429',
  'internal/errors':'fd278208fae3a83b51a0b948540629ed4e5fd8c7860cb8e4775c6dbf25779750',
  'internal/validators':'b01b3b0ce9919f157ec0b193bb2cf72ccb1a708cc8c3786acff8afb1287a4f46',
  'internal/assert':'03940c9b646255b631d3a95cf2a9ad156d587db8b0ac223d1a87f3fd5531a807',
}
if(process.version!=='v24.15.0')throw Error('Run with the pinned Node v24.15.0')
const natives=process.binding('natives')
const hash=source=>createHash('sha256').update(source).digest('hex')
for(const [key,expected] of Object.entries(hashes))if(hash(natives[key])!==expected)throw Error('Unexpected Node source: '+key)
const ast=key=>ts.createSourceFile(key+'.js',natives[key],ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
const declarations=(key,names)=>{
  const file=ast(key),wanted=new Set(names),out=[]
  for(const statement of file.statements){
    if(ts.isFunctionDeclaration(statement)&&wanted.delete(statement.name?.text))out.push(statement.getText(file))
    if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations){
      const name=ts.isIdentifier(declaration.name)?declaration.name.text:declaration.initializer?.getText(file)==='primordials'?'@primordials':undefined
      if(wanted.delete(name))out.push((statement.declarationList.flags&ts.NodeFlags.Const?'const ':statement.declarationList.flags&ts.NodeFlags.Let?'let ':'var ')+declaration.getText(file)+';')
    }
  }
  if(wanted.size)throw Error('Missing declarations '+key+': '+[...wanted])
  return out.join('\n')
}
const modules={
  'internal/util/inspect':natives['internal/util/inspect'],
  'internal/assert':natives['internal/assert'],
  'internal/util':declarations('internal/util',['@primordials','colorRegExp','removeColors','isError','join'])+`
const {isNativeError}=require('internal/util/types');
module.exports={removeColors,isError,join,customInspectSymbol:Symbol.for('nodejs.util.inspect.custom')};`,
  'internal/errors':declarations('internal/errors',['@primordials','kIsNodeError','messages','codes','classRegExp','kTypes','internalUtilInspect','lazyInternalUtilInspect','maxStack_ErrorName','maxStack_ErrorMessage','isStackOverflowError','determineSpecificType','formatList','makeNodeErrorWithCode','makeNodeErrorForHideStackFrame','getExpectedArgumentLength','getMessage','hideStackFrames','isErrorStackTraceLimitWritable']),
  'internal/validators':declarations('internal/validators',['@primordials','kValidateObjectNone','kValidateObjectAllowNullable','kValidateObjectAllowArray','kValidateObjectAllowFunction','validateObject','validateString']),
}
// Node uses a private Buffer method here. The guest Buffer exposes the same
// byte slicing through its public toString API, including empty ranges.
const hexSlice=`  if (hexSlice === undefined)
    hexSlice = uncurryThis(require('buffer').Buffer.prototype.hexSlice);`
if(modules['internal/util/inspect'].split(hexSlice).length!==2)throw Error('Buffer slice integration site changed')
modules['internal/util/inspect']=modules['internal/util/inspect'].replace(hexSlice,`  if (hexSlice === undefined) {
    const bufferToString = uncurryThis(require('buffer').Buffer.prototype.toString);
    hexSlice = (buffer, start, end) => {
      end = NumberIsNaN(end) ? 0 : MathTrunc(end);
      if (end < 0 || end > TypedArrayPrototypeGetLength(buffer))
        throw new RangeError('Index out of range');
      return bufferToString(buffer, 'hex', start, end);
    };
  }`)
// This runtime cannot deserialize Node startup snapshots. Keep the descriptor
// checks, omitting only the branch that asks Node's snapshot subsystem.
const snapshotGuard=`  if (require('internal/v8/startup_snapshot').namespace.isBuildingSnapshot()) {
    return false;
  }\n`
if(modules['internal/errors'].split(snapshotGuard).length!==2)throw Error('Snapshot guard changed')
modules['internal/errors']=modules['internal/errors'].replace(snapshotGuard,'')
modules['internal/errors']+="\nconst assert=require('internal/assert');\n"
for(const code of ['ERR_INTERNAL_ASSERTION','ERR_INVALID_ARG_TYPE']){
  const file=ast('internal/errors')
  const call=file.statements.find(s=>ts.isExpressionStatement(s)&&ts.isCallExpression(s.expression)&&s.expression.expression.getText(file)==='E'&&s.expression.arguments[0]?.text===code)?.expression
  if(!call)throw Error('Missing error definition '+code)
  modules['internal/errors']+=`messages.set(${JSON.stringify(code)},${call.arguments[1].getText(file)});\ncodes.${code}=makeNodeErrorWithCode(${call.arguments[2].getText(file)},${JSON.stringify(code)});\n`
}
modules['internal/errors']+=`codes.ERR_INVALID_ARG_TYPE.HideStackFramesError=makeNodeErrorForHideStackFrame(codes.ERR_INVALID_ARG_TYPE,TypeError);
module.exports={codes,isStackOverflowError,hideStackFrames};`
// The declarations initialize validators immediately, so provide their imports first.
modules['internal/validators']=`const {codes:{ERR_INVALID_ARG_TYPE:{HideStackFramesError:ERR_INVALID_ARG_TYPE}},hideStackFrames}=require('internal/errors');\n`+modules['internal/validators']+`
module.exports={validateObject,validateString,kValidateObjectAllowArray};`
const directory='src/compiler/vendor/node24'
const namespaceCapture='  copyPropsRenamed(globalThis[name], primordials, name);'
let primordialSource=natives['internal/per_context/primordials']
if(primordialSource.split(namespaceCapture).length!==2)throw Error('Namespace capture integration site changed')
primordialSource=primordialSource.replace(namespaceCapture,`  // The WASM engine has no Atomics. Inspection does not use it.
  if (name === 'Atomics' && globalThis[name] === undefined) return;
${namespaceCapture}`)
const output=`// Generated from pinned Node sources by scripts/vendor-node-inspection.mjs.
// Node.js MIT license is retained in LICENSE in this directory.
exports.createPrimordials=function(){const primordials={};
${primordialSource}
return primordials;};
exports.factories={${Object.entries(modules).map(([name,source])=>`${JSON.stringify(name)}:function(module,exports,require,primordials,internalBinding,process){\n${source}\n}`).join(',\n')}};\n`
writeFileSync(directory+'/inspection-generated.cjs',output)
writeFileSync(directory+'/inspection-provenance.json',JSON.stringify({version:process.version,license:'MIT',sources:hashes,outputSHA256:hash(output),changes:['CommonJS factories receive private dependencies and guest primordials.','Retain only declarations used by inspection from util, errors and validators.','Register the two error codes used by inspection with the original Node constructors and messages.','Omit the Node startup-snapshot guard; this runtime cannot deserialize those snapshots.','Use Buffer.prototype.toString with hex encoding instead of Node private hexSlice, retaining endpoint conversion and bounds errors for the inspector-created Uint8Array.','Skip primordial Atomics capture only when the runtime does not provide that optional namespace.']},null,2)+'\n')
// Fail if the existing license is accidentally lost during vendoring.
if(!readFileSync(directory+'/LICENSE','utf8').includes('Permission is hereby granted'))throw Error('Missing Node license')
