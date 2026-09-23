import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'

const require=createRequire(resolve('fixtures/compiler-wasi/package.json'))
const binding=require('@rolldown/binding-wasm32-wasi')
const root=resolve('fixtures/rolldown-tsx')
const filesystem=process.argv.includes('--filesystem')
const modules=Object.fromEntries(['main.tsx','lazy.ts'].map(name=>[join(root,name),readFileSync(join(root,name),'utf8')]))
let bundler
try{
  binding.startAsyncRuntime();bundler=new binding.BindingBundler()
  const output=await bundler.generate({inputOptions:{
    input:[{name:'main',import:join(root,'main.tsx')}],cwd:root,platform:'neutral',
    logLevel:binding.BindingLogLevel.Silent,onLog:()=>{},
    transform:{jsx:{runtime:'classic',pragma:'h'}},
    plugins:filesystem?[]:[{name:'tsx-fixture',hookUsage:10,
      resolveId:(_ctx,id,importer)=>{const path=importer?resolve(dirname(importer),id):id;return path in modules?{id:path}:null},
      load:(_ctx,id)=>id in modules?{code:modules[id],moduleType:id.endsWith('.tsx')?'tsx':'ts'}:null,
    }],
  },outputOptions:{plugins:[],format:'es',entryFileNames:'main.mjs',chunkFileNames:'[name]-[hash].mjs',sourcemap:'file'}})
  if(output.isBindingErrors)throw Error(JSON.stringify(output.errors))
  assert.ok(output.chunks.length>=2)
  const out=mkdtempSync(join(tmpdir(),'rolldown-tsx-output-'))
  const chunks=[]
  for(const chunk of output.chunks){
    const fileName=chunk.getFileName(),code=chunk.getCode(),map=chunk.getMap()
    assert.ok(map,'Missing source map for '+fileName)
    const parsed=JSON.parse(map);assert.equal(parsed.version,3);assert.ok(parsed.sources.length>0)
    const path=join(out,fileName);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,code);writeFileSync(path+'.map',map)
    chunks.push({fileName,bytes:Buffer.byteLength(code),sources:parsed.sources,mapBytes:Buffer.byteLength(map)})
  }
  const executed=await import(pathToFileURL(join(out,'main.mjs')).href)
  assert.deepEqual(executed.view,{tag:'output',props:{answer:42},children:['ready']})
  assert.equal(await executed.loadAnswer(),42)
  console.log(JSON.stringify({scope:'Native unchanged WASI binding, TSX and dynamic-import emitted execution',filesystem,version:require('@rolldown/binding-wasm32-wasi/package.json').version,chunks,view:executed.view,dynamicResult:42,outputDirectory:out},null,2))
}finally{
  if(bundler)await bundler.close()
  binding.shutdownAsyncRuntime()
}
process.exit(0)
