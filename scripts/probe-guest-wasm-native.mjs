import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {runInNewContext} from 'node:vm'
import {guestWasmCases} from '../fixtures/guest-wasm-cases.mjs'
import {guestWasmInputHashes} from './guest-wasm-evidence.mjs'
const inputs=guestWasmInputHashes()
const engine=JSON.parse(readFileSync('public/quickjs-als-wasm/build.json','utf8'))
const directory=engine.guestWasm.directory
if(!directory.includes('/quickjs-guest-wasm-'))throw Error('Unexpected source directory')
const executable=join(directory,'guest-allocation-asan')
const control=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/controls.wasm')),md4=Uint8Array.from(readFileSync('public/wasm-interpreter-probe/webpack-md4.wasm'))
const callbackBytes=[...readFileSync('public/guest-wasm/callback.wasm')]
const memoryBytes=[...readFileSync('public/guest-wasm/memory-import.wasm')]
const globalBytes=[...readFileSync('public/guest-wasm/global-values.wasm')],globalImportBytes=[...readFileSync('public/guest-wasm/global-import.wasm')]
const tableBytes=[...readFileSync('public/guest-wasm/table-owner.wasm')],tableImportBytes=[...readFileSync('public/guest-wasm/table-import.wasm')]
const regressions=join(directory,'guest-regressions.js')
writeFileSync(regressions,`(()=>{const control=new Uint8Array(${JSON.stringify([...control])}),md4=new Uint8Array(${JSON.stringify([...md4])});\n`+
  guestWasmCases.map(row=>`globalThis.currentCase=${JSON.stringify(row.name)};if(eval(${JSON.stringify(row.code)})!==${JSON.stringify(runInNewContext(row.code,{control,md4,WebAssembly},{timeout:3000}))})throw Error(${JSON.stringify(row.name)});`).join('\n')+
  `\n})();globalThis.weakOwnerMap??=new WeakMap();globalThis.retainedBuffers=(()=>{const bytes=new Uint8Array(${JSON.stringify(callbackBytes)}),buffers=[];for(let n=0;n<10;n++){const box={};const i=new WebAssembly.Instance(new WebAssembly.Module(bytes),{host:{callback:()=>box.instance.exports.call}});box.instance=i;weakOwnerMap.set(box,i);const b=i.exports.memory.buffer;new Uint8Array(b)[0]=17;buffers.push(b)}return buffers})();
  globalThis.survivingMemory=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(callbackBytes)})),{host:{callback:n=>n}}).exports.memory;
  new Uint8Array(survivingMemory.buffer)[0]=57;
  globalThis.survivingRead=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(memoryBytes)})),{host:{memory:survivingMemory,callback:n=>n}}).exports.read;
  globalThis.retainedGlobals=(()=>{const m=new WebAssembly.Module(new Uint8Array(${JSON.stringify(globalBytes)})),out=[];for(let n=0;n<10;n++)out.push(new WebAssembly.Instance(m).exports.i);return out})();
  globalThis.survivingGlobal=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(globalBytes)}))).exports.i;survivingGlobal.value=37;
  globalThis.survivingGlobalRead=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(globalImportBytes)})),{host:{value:survivingGlobal,constant:23,long:1n}}).exports.read;
  (()=>{
    const source=new WebAssembly.Module(new Uint8Array(${JSON.stringify(tableBytes)})),importer=new WebAssembly.Module(new Uint8Array(${JSON.stringify(tableImportBytes)}));
    globalThis.survivingTable=new WebAssembly.Instance(source,{host:{callback:n=>n}}).exports.table;
    globalThis.survivingTableCall=new WebAssembly.Instance(importer,{host:{table:survivingTable}}).exports.call;
    globalThis.savedReference=(()=>{
      const a=new WebAssembly.Instance(source,{host:{callback:n=>n}}).exports,b=new WebAssembly.Instance(source,{host:{callback:n=>n}}).exports;
      b.table.set(0,a.read);b.save(0);b.clear(0);a.clear(0);a.clear(1);return b;
    })();
    const box={};
    box.table=new WebAssembly.Instance(source,{host:{callback:n=>{
      box.table.set(0,null);box.table.set(1,null);collectDuringCallback();return n;
    }}}).exports.table;
    const call=new WebAssembly.Instance(importer,{host:{table:box.table}}).exports.call;
    if(call(0,25)!==42||box.table.get(0)!==null)throw Error('active indirect callee collected');
  })();`)
const args=['-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-D_GNU_SOURCE','-DCONFIG_VERSION="spike"',
  '-DQJS_GUEST_WASM','-Dd_m3MaxLinearMemoryPages=1024','-Dd_m3MaxNativeStack=131072','-Dd_m3HasExceptionHandling=0',
  '-I'+join(directory,'quickjs'),'-I'+join(directory,'source'),resolve('fixtures/guest-wasm-allocation-native.c'),resolve('src/sandbox/guest-wasm.c'),
  ...['quickjs','dtoa','libregexp','libunicode','cutils'].map(name=>join(directory,'quickjs',name+'.c')),
  ...readdirSync(join(directory,'source')).filter(name=>name.endsWith('.c')).map(name=>join(directory,'source',name)),'-lm','-o',executable]
const build=spawnSync('cc',args,{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})
const run=build.status===0?spawnSync(executable,[resolve('src/sandbox/guest-wasm.js'),resolve('public/wasm-interpreter-probe/controls.wasm'),resolve('public/guest-wasm/callback.wasm'),resolve('public/guest-wasm/memory-import.wasm'),resolve('public/compiler-depth/block-256.wasm'),resolve('public/compiler-depth/else-32.wasm'),resolve('public/guest-wasm/global-import.wasm'),regressions,resolve('public/guest-wasm/table-owner.wasm'),resolve('public/guest-wasm/table-import.wasm')],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):undefined
const report={engine,inputs,args,build:{status:build.status,stderr:build.stderr},run:run?{status:run.status,signal:run.signal,stdout:run.stdout,stderr:run.stderr,error:String(run.error??'')}:null}
writeFileSync('reports/guest-wasm-asan.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({build:report.build,run:report.run&&{...report.run,stderr:report.run.status===0?'':report.run.stderr.slice(-6500)}},null,2))
if(build.status!==0||run?.status!==0)process.exitCode=1
