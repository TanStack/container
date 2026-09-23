import {build} from 'vite'
import {mkdtempSync,mkdirSync,cpSync,copyFileSync,writeFileSync,readFileSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {verifySDK} from './verify-sdk.mjs'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'

const supplied=process.env.SDK_OUTPUT??process.argv[2]
if(!supplied)throw Error('Supply SDK_OUTPUT or an SDK output directory argument')
const sdk=resolve(supplied)
verifySDK(sdk)
const metadata=JSON.parse(readFileSync(join(sdk,'package.json'),'utf8'))
if(metadata.name!=='@tanstack/browser-sandbox-experimental')throw Error('Unexpected SDK package name')
const app=realpathSync(mkdtempSync(join(tmpdir(),'browser-sandbox-vite-consumer-')))
const dependency=join(app,'node_modules','@tanstack','browser-sandbox-experimental')
mkdirSync(join(app,'node_modules','@tanstack'),{recursive:true})
cpSync(sdk,dependency,{recursive:true,errorOnExist:true,force:false})
mkdirSync(join(app,'public'))
// Runtime engines are dynamically selected by the kernel, not discoverable by
// the outer bundler. The consumer explicitly hosts them and passes their URL.
const assetHelper=createRequire(join(app,'package.json')).resolve('@tanstack/browser-sandbox-experimental/assets')
const {copyRuntimeAssets}=await import(pathToFileURL(assetHelper).href)
copyRuntimeAssets(join(app,'public','runtime'))
writeFileSync(join(app,'package.json'),JSON.stringify({
  name:'sdk-vite-consumer',private:true,type:'module',
  dependencies:{[metadata.name]:metadata.version},
},null,2)+'\n')
copyFileSync('tests/fixtures/sdk-vite-consumer.ts.txt',join(app,'main.ts'))
writeFileSync(join(app,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><title>SDK Vite consumer</title></head><body><pre id="result">Running</pre><script type="module" src="/main.ts"></script></body></html>\n')
const warnings=[]
console.log('VITE_CONSUMER_APP='+app)
try{
  await build({configFile:false,root:app,base:'./',worker:{format:'es'},
    build:{outDir:join(app,'dist'),emptyOutDir:false,target:'es2022',rollupOptions:{
      onwarn(warning,defaultHandler){warnings.push({code:warning.code,message:warning.message,id:warning.id});defaultHandler(warning)},
    }},
  })
  console.log('VITE_CONSUMER_OUTPUT='+join(app,'dist'))
}finally{
  writeFileSync(join(app,'build-evidence.json'),JSON.stringify({
    sdk,app,runtimeIntegration:'Copy installed SDK runtime/ to public/runtime/ and pass new URL("./runtime/", document.baseURI).href as assetBaseURL.',
    compiler:'Outer consumer built by host Vite. Guest TypeScript compiled by SDK kernel.run inside browser.',warnings,
  },null,2)+'\n')
}
