import {build} from 'esbuild'
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import {guestBufferPlugin} from './guest-buffer-plugin.mjs'
import {streamFinishedPlugin} from './stage-stream-finished.mjs'
import {addPackageNotices} from './package-notices.mjs'

const result=await build({entryPoints:['src/compiler/node-core-entry.js'],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',
  define:{global:'globalThis',process:'globalThis.process'},alias:{stream:'stream-browserify'},legalComments:'inline',metafile:true,
  plugins:[guestBufferPlugin(),streamFinishedPlugin(),{name:'guest-buffer',setup(b){
    // The package's browser entry only reexports self.AbortController. QuickJS
    // may have no optional Web globals, so bundle its actual implementation.
    b.onResolve({filter:/^abort-controller$/},()=>({path:resolve('node_modules/abort-controller/dist/abort-controller.js')}))
    b.onResolve({filter:/^(process\/?|node:process|events)$/},args=>({path:args.path,namespace:'guest-core-authority'}))
    b.onLoad({filter:/.*/,namespace:'guest-core-authority'},args=>({contents:args.path==='events'?'module.exports=globalThis.__webContainerHost.EventEmitter':'module.exports=globalThis.process'}))
    b.onResolve({filter:/^buffer$/},()=>({path:'buffer',namespace:'guest-buffer'}))
    b.onLoad({filter:/.*/,namespace:'guest-buffer'},()=>({contents:`import implementation from 'buffer/';
      const Buffer=globalThis.Buffer??=implementation.Buffer;
      export {Buffer};export const SlowBuffer=implementation.SlowBuffer,INSPECT_MAX_BYTES=implementation.INSPECT_MAX_BYTES,kMaxLength=implementation.kMaxLength;
      export default {...implementation,Buffer};`,resolveDir:process.cwd()}))
  }}]})
mkdirSync('src/compiler/generated',{recursive:true})
writeFileSync('src/compiler/generated/node-core.js',result.outputFiles[0].text)
const dependencies=new Map()
for(const file of Object.keys(result.metafile.inputs)){
  if(!file.startsWith('node_modules/'))continue
  let directory=dirname(resolve(file))
  while(directory!==dirname(directory)){
    if(existsSync(join(directory,'package.json'))){
      const pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'))
      if(pkg.name&&pkg.version){
        addPackageNotices(dependencies,directory,pkg)
        break
      }
    }
    directory=dirname(directory)
  }
}
mkdirSync('public/kernel-runtime',{recursive:true})
dependencies.set('node-js-core-port',{name:'Node.js core port',version:'24.15.0',license:'MIT',notices:readFileSync('src/compiler/vendor/node24/LICENSE','utf8')})
writeFileSync('public/kernel-runtime/THIRD-PARTY-NOTICES.txt',[...dependencies.values()].map(x=>`${x.name}@${x.version}\n${x.license}\n${x.notices}`).join('\n\n'))
