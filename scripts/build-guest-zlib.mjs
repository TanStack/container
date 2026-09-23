import {build} from 'esbuild'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

// Bundle the compression engine only. Streams, Buffer and errors belong to the
// existing guest core, and this code is initialized only when zlib is imported.
const result=await build({stdin:{contents:`exports.binding=require('browserify-zlib/lib/binding.js');exports.crc32=require('pako/lib/zlib/crc32.js');`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',
  define:{process:'globalThis.process',Buffer:'globalThis.Buffer'},legalComments:'inline',metafile:true,
  plugins:[{name:'guest-zlib-core',setup(build){
    build.onLoad({filter:/browserify-zlib\/lib\/binding\.js$/},args=>{
      const source=readFileSync(args.path,'utf8')
      if(createHash('sha256').update(source).digest('hex')!=='e8b078206d7645916f27c4c4eca6dc385eccff368e49ef2d9374225d37f7e6bc')throw Error('Compression binding changed; review the zero-window decoder fix')
      const original='assert(windowBits >= 8 && windowBits <= 15, \'invalid windowBits\');'
      const replacement='assert((windowBits >= 8 && windowBits <= 15) || (windowBits === 0 && [exports.INFLATE, exports.GUNZIP, exports.UNZIP].includes(this.mode)), \'invalid windowBits\');'
      if(source.split(original).length!==2)throw Error('Compression window validation boundary changed')
      return {contents:source.replace(original,replacement),loader:'js'}
    })
    build.onResolve({filter:/^assert$/},()=>({path:'assert',namespace:'guest-zlib-core'}))
    build.onLoad({filter:/.*/,namespace:'guest-zlib-core'},()=>({contents:'module.exports=globalThis.__webContainerHost.nodeCore.assert'}))
  }}]})
mkdirSync('src/compiler/generated',{recursive:true});mkdirSync('public/kernel-runtime',{recursive:true})
writeFileSync('src/compiler/generated/zlib.js',result.outputFiles[0].text)
const inputs=Object.keys(result.metafile.inputs).filter(path=>!path.startsWith('guest-zlib-core:')&&path!=='<stdin>').sort()
writeFileSync('public/kernel-runtime/zlib-build.json',JSON.stringify({sha256:createHash('sha256').update(result.outputFiles[0].text).digest('hex'),inputs:inputs.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}))},null,2)+'\n')
writeFileSync('public/kernel-runtime/ZLIB-NOTICES.txt',['browserify-zlib','pako'].flatMap(name=>{const pkg=JSON.parse(readFileSync('node_modules/'+name+'/package.json','utf8'));return [pkg.name+'@'+pkg.version,readFileSync('node_modules/'+name+'/LICENSE','utf8')]}).join('\n\n'))
