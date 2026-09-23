import {build,transform} from 'esbuild'
import {readFileSync,writeFileSync,mkdtempSync,cpSync,copyFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {inspectionCases} from '../fixtures/inspection-cases.mjs'
import {stageConstructorMetadata} from './stage-constructor-metadata.mjs'
import {guestBufferPlugin} from './guest-buffer-plugin.mjs'

const engine=JSON.parse(readFileSync('public/quickjs-als-wasm/build.json'))
const directory=mkdtempSync(join(tmpdir(),'quickjs-inspection-formatter-')),qjs=join(directory,'quickjs')
cpSync(join(engine.guestWasm.directory,'quickjs'),qjs,{recursive:true})
if(engine.inspection){
  if(createHash('sha256').update(readFileSync('scripts/stage-constructor-metadata.mjs')).digest('hex')!==engine.inspection.constructorMetadataSHA256)throw Error('Constructor metadata differs from engine build')
  copyFileSync('src/sandbox/guest-inspect.c',join(qjs,'qjs-inspect.h'))
}else stageConstructorMetadata(join(qjs,'quickjs.c'))
const bundle=await build({entryPoints:['fixtures/inspection-formatter-entry.js'],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',metafile:true,plugins:[guestBufferPlugin()]})
const cases={}
for(const [name,source] of Object.entries(inspectionCases))cases[name]=(await transform(source,{format:'cjs',target:'es2022'})).code
const checkSetup=`
globalThis.run=function(){
  const output={};
  for(const [name,source] of Object.entries(${JSON.stringify(cases)})){
    const lines=[];
    try{new Function('require','console',source)(name=>{if(name!=='node:util')throw Error('Unexpected fixture import');return formatter;},{log:value=>lines.push(value)});output[name]={lines};}
    catch(error){output[name]={error:{name:error.name,message:error.message}};}
  }
  return JSON.stringify(output);
};
const formatterReference=run();
globalThis.checkRetained=function(){
  if(formatter.inspect(new Map([['retained',42]]))!=="Map(1) { 'retained' => 42 }")throw Error('Lost formatter state');
  if('inspection' in globalThis)throw Error('Private inspection binding exposed');
  if(run()!==formatterReference)throw Error('Formatter did not recover its original output');
};`
const web=readFileSync('public/vm-web-apis/globals.js','utf8')
const code=`${web}\nconst formatter=(()=>{const module={exports:{}};const exports=module.exports;${bundle.outputFiles[0].text}\nconst binding=globalThis.inspection;delete globalThis.inspection;return module.exports.initialize(binding);})();\n${checkSetup}`
const source=join(directory,'formatter.js'),exe=join(directory,'probe')
writeFileSync(source,code)
const files=['scripts/probe-inspection-formatter.mjs','scripts/stage-constructor-metadata.mjs','scripts/vendor-node-inspection.mjs','scripts/guest-buffer-plugin.mjs','src/compiler/buffer-utf8-slice.js','fixtures/inspection-native.c','fixtures/inspection-cases.mjs','src/sandbox/guest-inspect.c','public/vm-web-apis/globals.js',...Object.keys(bundle.metafile.inputs),...['quickjs','dtoa','libregexp','libunicode','cutils'].map(n=>join(qjs,n+'.c'))]
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const hashes=Object.fromEntries(files.map(file=>[file,hash(readFileSync(file))]))
const args=['-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-D_GNU_SOURCE','-DCONFIG_VERSION="spike"','-I'+qjs,'-I'+resolve('src/sandbox'),resolve('fixtures/inspection-native.c'),...['dtoa','libregexp','libunicode','cutils'].map(n=>join(qjs,n+'.c')),'-lm','-o',exe]
const options={encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024}
const compile=spawnSync('cc',args,options)
const oracle=spawnSync(process.execPath,['-e',`const formatter=require('node:util');${checkSetup};console.log(run());checkRetained()`],options)
const native=compile.status===0?spawnSync(exe,[source,'comparison'],{...options,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):null
const allocation=native?.status===0?spawnSync(exe,[source,'allocation'],{...options,timeout:300000,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):null
const summarize=x=>x&&({status:x.status,signal:x.signal,stdout:x.stdout,stderr:x.stderr,error:String(x.error??'')})
const differences=[]
if(oracle.status===0&&native?.status===0){
  const expected=JSON.parse(oracle.stdout),actual=JSON.parse(native.stdout)
  for(const name of Object.keys(cases))if(JSON.stringify(expected[name])!==JSON.stringify(actual[name]))differences.push({name,expected:expected[name],actual:actual[name]})
}
const matched=oracle.status===0&&native?.status===0&&differences.length===0
const report={scope:'Pinned Node formatter in native QuickJS with private inspection binding; not browser builtin integration',engine,hashes,sourceSHA256:hash(code),args,compile:summarize(compile),oracle:summarize(oracle),native:summarize(native),allocation:summarize(allocation),caseCount:Object.keys(cases).length,matched,differences}
writeFileSync('reports/inspection-formatter-native.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({...report,engine:undefined,hashes:undefined,args:undefined,oracle:undefined,native:native&&{...summarize(native),stdout:undefined}},null,2))
if(!matched||allocation?.status!==0||native.stderr||allocation.stderr)process.exitCode=1
