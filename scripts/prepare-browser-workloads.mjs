import {mkdir,copyFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {build} from 'esbuild'
const root=fileURLToPath(new URL('../fixtures/workloads/',import.meta.url))
const out=fileURLToPath(new URL('../public/workloads/browser/',import.meta.url))
for(const name of ['esbuild','rollup','sqlite','python'])await mkdir(path.join(out,name),{recursive:true})
for(const [pkg,source,target] of [
  ['esbuild-wasm','esm/browser.js','esbuild/index.mjs'],['esbuild-wasm','esbuild.wasm','esbuild/esbuild.wasm'],
  ['@rollup/browser','dist/es/rollup.browser.js','rollup/index.mjs'],['@rollup/browser','dist/es/bindings_wasm_bg.wasm','rollup/bindings_wasm_bg.wasm'],
  ['sql.js','dist/sql-wasm.wasm','sqlite/sql-wasm.wasm'],
  ...['pyodide.mjs','pyodide.asm.mjs','pyodide.asm.wasm','pyodide-lock.json','python_stdlib.zip'].map(name=>['pyodide',name,'python/'+name]),
])await copyFile(path.join(root,'node_modules',pkg,source),path.join(out,target))
await build({entryPoints:[path.join(root,'node_modules/sql.js/dist/sql-wasm.js')],outfile:path.join(out,'sqlite/index.mjs'),bundle:true,
  platform:'browser',format:'esm',external:['fs','path','crypto','node:*'],logLevel:'silent'})
await writeFile(path.join(out,'worker.mjs'),`
// Trusted, fixed experiments. These workers are not a hostile-code boundary.
let service;
try {
  const name=new URL(location.href).searchParams.get('runtime');
  if(name==='esbuild'){
    service=await import('./esbuild/index.mjs');
    await service.initialize({wasmURL:new URL('./esbuild/esbuild.wasm',location.href).href,worker:false});
  }else if(name==='rollup')service=await import('./rollup/index.mjs');
  else if(name==='sqlite'){const {default:init}=await import('./sqlite/index.mjs');service=await init({locateFile:name=>new URL('./sqlite/'+name,location.href).href})}
  else if(name==='python'){const {loadPyodide}=await import('./python/pyodide.mjs');service=await loadPyodide({indexURL:new URL('./python/',location.href).href})}
  else throw Error('Unknown runtime');
  const values=[];
  for(const seed of [3,7,7,3]){
    if(name==='esbuild'){
      const out=await service.build({stdin:{contents:'import {value} from "value"; globalThis.answer=value*2'},bundle:true,write:false,format:'iife',
        plugins:[{name:'files',setup(b){b.onResolve({filter:/^value$/},()=>({path:'value',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const value='+seed}))}}]});
      (0,eval)(out.outputFiles[0].text);values.push(globalThis.answer);
    }else if(name==='rollup'){
      const bundle=await service.rollup({input:'main',plugins:[{name:'files',resolveId:id=>id,load:id=>id==='main'?'import {value} from "value"; globalThis.answer=value*2':'export const value='+seed}]});
      try{const out=await bundle.generate({format:'iife'});(0,eval)(out.output[0].code);values.push(globalThis.answer)}finally{await bundle.close()}
    }else if(name==='sqlite'){
      const db=new service.Database();try{db.run('CREATE TABLE values_table (value INTEGER)');db.run('INSERT INTO values_table VALUES (?)',[seed]);values.push(db.exec('SELECT value * 2 FROM values_table')[0].values[0][0])}finally{db.close()}
    }else{
      service.FS.writeFile('/value.txt',String(seed));values.push(await service.runPythonAsync('int(open("/value.txt").read()) * 2'));
    }
  }
  if(name==='esbuild')await service.stop();
  self.postMessage({status:'adapted-pass',runtime:name,values,placement:'trusted browser worker, outside QuickJS',crossOriginIsolated:self.crossOriginIsolated});
}catch(error){try{await service?.stop?.()}catch{}self.postMessage({status:'gap',error:String(error)})}
`)
console.log('Prepared browser-native esbuild, Rollup, SQLite, and Python workers')
