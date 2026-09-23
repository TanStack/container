import {build,transform} from 'esbuild'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {readPackageNotices} from './package-notices.mjs'
await import('./build-node-core.mjs')
await import('./build-guest-zlib.mjs')
await import('./build-brotli-wasm.mjs')

// Compile only our trusted builtin definitions, never project code on the host.
const definitions=await build({entryPoints:['src/compiler/builtins.ts'],bundle:true,write:false,format:'esm',platform:'node',
  plugins:[{name:'raw-source',setup(b){
    b.onResolve({filter:/\?raw$/},args=>({path:resolve(args.path.startsWith('.')?args.resolveDir:'node_modules',args.path.slice(0,-4)),namespace:'raw'}))
    b.onLoad({filter:/.*/,namespace:'raw'},args=>({contents:'export default '+JSON.stringify(readFileSync(args.path,'utf8')),loader:'js'}))
  }}]})
const {builtinModules}=await import('data:text/javascript;base64,'+Buffer.from(definitions.outputFiles[0].text).toString('base64'))
const modules={}
for(const [name,source] of Object.entries(builtinModules)){
  const metadata=await build({stdin:{contents:source},write:false,format:'esm',metafile:true})
  modules[name]={exports:Object.values(metadata.metafile.outputs)[0].exports,cjs:(await transform(source,{format:'cjs',target:'es2022',minifyWhitespace:true,legalComments:'inline'})).code}
}
const sqlSource=readFileSync('fixtures/workloads/node_modules/sql.js/dist/sql-wasm.js','utf8')
const sqlWasm=readFileSync('fixtures/workloads/node_modules/sql.js/dist/sql-wasm.wasm').toString('base64')
const sqliteEncoding=await build({stdin:{contents:"export {TextDecoder} from '@kayahr/text-encoding'",resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'sqliteEncoding',platform:'browser',target:'es2022',minify:true})
// sql.js is CommonJS, including mutable wrapper arguments and Node's require.
// WASM bytes are embedded, so this private filename is only a resolution base.
const preparations=[{name:'sqlite',requiresGuestWasm:true,source:`async()=>{${sqliteEncoding.outputFiles[0].text}\nconst {TextDecoder}=sqliteEncoding;const module={exports:{}};const init=(function(require,module,exports,__filename,__dirname){${sqlSource}\nreturn module.exports.default??module.exports;})(globalThis.__webContainerHost.modules.createRequire('/__builtin/sqlite/sql-wasm.js'),module,module.exports,'/__builtin/sqlite/sql-wasm.js','/__builtin/sqlite');globalThis.__webContainerHost.preparedBuiltins.sqlite=await init({wasmBinary:Buffer.from(${JSON.stringify(sqlWasm)},'base64')})}`}]
mkdirSync('public/kernel-runtime',{recursive:true})
const inspection=await build({entryPoints:['src/compiler/node-inspection.cjs'],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',legalComments:'inline'})
const source=JSON.stringify({version:2,modules,assets:{'brotli-wasm':{path:'kernel-runtime/brotli.wasm'}},preparations,inspection:inspection.outputFiles[0].text})
writeFileSync('public/kernel-runtime/builtins.json',source)
const brotliAsset=readFileSync('public/kernel-runtime/brotli.wasm')
writeFileSync('public/kernel-runtime/build.json',JSON.stringify({sha256:createHash('sha256').update(source).digest('hex'),modules:Object.keys(modules),assets:{'brotli-wasm':{path:'kernel-runtime/brotli.wasm',bytes:brotliAsset.length,sha256:createHash('sha256').update(brotliAsset).digest('hex')}}},null,2)+'\n')
const punycodeDirectory=resolve('node_modules/tr46/node_modules/punycode')
const punycodePackage=JSON.parse(readFileSync(punycodeDirectory+'/package.json','utf8'))
const punycodeNotice=`${punycodePackage.name}@${punycodePackage.version}\n${punycodePackage.license}\n${readPackageNotices(punycodeDirectory)}`
const brotliDirectory=resolve('node_modules/wasm-brotli')
const brotliPackage=JSON.parse(readFileSync(brotliDirectory+'/package.json','utf8'))
const brotliNotice=`${brotliPackage.name}@${brotliPackage.version}\n${brotliPackage.license}\n${readPackageNotices(brotliDirectory)}`
const noticesPath='public/kernel-runtime/THIRD-PARTY-NOTICES.txt',existingNotices=readFileSync(noticesPath,'utf8').trimEnd()
writeFileSync(noticesPath,existingNotices+'\n\n'+punycodeNotice+'\n\n'+brotliNotice+'\n')
const hashFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
writeFileSync('public/kernel-runtime/SHIPPED-INPUTS.json',JSON.stringify({format:1,scope:'Inputs shipped in the generated kernel runtime',packages:[
  {name:punycodePackage.name,version:punycodePackage.version,license:punycodePackage.license,source:'node_modules/tr46/node_modules/punycode/punycode.js',sourceSHA256:hashFile(punycodeDirectory+'/punycode.js'),licenseFile:'node_modules/tr46/node_modules/punycode/LICENSE-MIT.txt',licenseSHA256:hashFile(punycodeDirectory+'/LICENSE-MIT.txt'),runtimeModule:'node:punycode',compatibilityVersion:'2.1.0'},
  {name:brotliPackage.name,version:brotliPackage.version,license:brotliPackage.license,source:'node_modules/wasm-brotli/wasm_brotli_browser_bg.wasm',sourceSHA256:hashFile(brotliDirectory+'/wasm_brotli_browser_bg.wasm'),licenseFile:'node_modules/wasm-brotli/LICENSE',licenseSHA256:hashFile(brotliDirectory+'/LICENSE'),runtimeModule:'node:zlib'},
]},null,2)+'\n')
console.log('Built runtime builtin modules:',Object.keys(modules).length)
