import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'

const emcc = resolve('.toolchains/emsdk/upstream/emscripten/emcc')
const argumentsList = process.argv.slice(2)
let optimization = 'Oz'
let lto = true
let alignedStack = false
for (let i = 0; i < argumentsList.length; i++) {
  if (argumentsList[i] === '--opt' && ['O1','Oz'].includes(argumentsList[i + 1])) optimization = argumentsList[++i]
  else if (argumentsList[i] === '--no-lto') lto = false
  else if (argumentsList[i] === '--aligned-stack') alignedStack = true
  else throw Error('Expected --opt O1|Oz, --no-lto or --aligned-stack')
}
const output = mkdtempSync(join(tmpdir(), 'fiber-pointer-loop-'))
const filename = join(output, 'probe.mjs')
const version = execFileSync(emcc, ['--version'], {encoding:'utf8',timeout:15000}).trim()
const flags = ['-'+optimization,...(lto?['-flto']:[]),...(alignedStack?['-DPROBE_ALIGNED_STACK=1']:[]),'--no-entry','-sMODULARIZE=1','-sEXPORT_ES6=1',
  '-sENVIRONMENT=node','-sALLOW_MEMORY_GROWTH=1','-sALLOW_TABLE_GROWTH=1',
  '-sSTACK_SIZE=5MB','-sIMPORTED_MEMORY=1','-sFILESYSTEM=0','-sASSERTIONS=1',
  '-sASYNCIFY=1','-sASYNCIFY_STACK_SIZE=262144','-lasync.js',
  '-sEXPORTED_RUNTIME_METHODS=["ccall"]',
  '-sEXPORTED_FUNCTIONS=["_probe_run","_probe_fact","_probe_reenter"]']
execFileSync(emcc, [resolve('fixtures/sort-diagnostics/fiber-pointer-loop.c'), ...flags,
  '-o',filename], {stdio:'inherit',timeout:120000})
// Execute separately so even an unexpected runtime failure has a wall-time bound.
const runner = `
import factory from ${JSON.stringify(pathToFileURL(filename).href)};
import {readFileSync} from 'node:fs';
const expected=[0,1,1,1,1,1,1,0,1,1,1,1,1,1,1,0,1,1,1];
const results=[];
for(const invocation of ['direct','ccall-async'])for(const [mode,name] of ['straight','fiber','fiber-reentered'].entries()){
 const module = await factory({wasmBinary:readFileSync(${JSON.stringify(join(output,'probe.wasm'))})});
 const status=invocation==='direct'?module._probe_run(mode,1):await module.ccall('probe_run','number',['number','number'],[mode,1],{async:true});
 const facts=expected.map((_,i)=>module._probe_fact(i)>>>0);
 results.push({name,invocation,status,facts,passed:facts.every((v,i)=>v===expected[i])});
}
console.log(JSON.stringify({expected,results}));
`
try {
  const result = execFileSync(process.execPath,['--input-type=module','-e',runner],
    {encoding:'utf8',timeout:15000})
  const hashes=Object.fromEntries(['fixtures/sort-diagnostics/fiber-pointer-loop.c',
    'scripts/probe-fiber-pointer-loop.mjs',filename,join(output,'probe.wasm')].map(path=>
    [path,createHash('sha256').update(readFileSync(path)).digest('hex')]))
  const report={version,output,optimization,lto,alignedStack,flags,hashes,...JSON.parse(result.trim())}
  mkdirSync('reports',{recursive:true})
  const attemptPath=join('reports',`fiber-pointer-loop-${optimization}-${lto?'lto':'no-lto'}-${alignedStack?'aligned':'malloc'}-${output.split('/').at(-1)}.json`)
  writeFileSync(attemptPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
  writeFileSync('reports/fiber-pointer-loop.json',JSON.stringify(report,null,2)+'\n')
  console.log('Report: '+attemptPath)
  console.log(JSON.stringify(report,null,2))
  process.exitCode=report.results.every(x=>x.passed)?0:1
} catch (error) {
  console.error(JSON.stringify({version,output,flags,stdout:String(error.stdout??''),
    stderr:String(error.stderr??''),error:String(error)},null,2))
  process.exitCode=1
}
