import {build} from 'esbuild'
import {writeFileSync,mkdirSync,readFileSync,existsSync} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import {createHash} from 'node:crypto'
import {guestBufferPlugin} from './guest-buffer-plugin.mjs'
import {stageFetchRequest} from './stage-fetch-request.mjs'
import {stageFetchResponse} from './stage-fetch-response.mjs'
import {stageTextEncoding} from './stage-text-encoding.mjs'
import {streamFinishedPlugin} from './stage-stream-finished.mjs'
import {addPackageNotices} from './package-notices.mjs'

const outputDirectory=resolve(process.env.VM_WEB_APIS_OUTPUT??'public/vm-web-apis')

// These implementations execute inside QuickJS, not in the host browser.
// Only request/response data types are installed. There is no network transport.
const aliases={stream:resolve('src/compiler/shared-stream.cjs'),http:'stream-http',url:'url/',buffer:'buffer/',
  'abort-controller':resolve('node_modules/abort-controller/dist/abort-controller.mjs'),
  '@web-std/blob':resolve('node_modules/@web-std/blob/src/lib.node.js'),
  '@web-std/file':resolve('node_modules/@web-std/file/src/lib.node.js'),
  '@web-std/form-data':resolve('node_modules/@web-std/form-data/src/lib.node.js')}
const stages=[
  `import {TextEncoder,TextDecoder} from '@kayahr/text-encoding'; import {Buffer} from 'buffer/'; import process from './src/compiler/shared-process.cjs';
   Object.assign(globalThis,{TextEncoder,TextDecoder,Buffer,process});`,
  `import {URL,URLSearchParams} from 'whatwg-url'; import * as streams from 'web-streams-polyfill';
   Object.assign(globalThis,{URL,URLSearchParams,...streams});`,
  `import Request from '@web-std/fetch/src/request.js'; import Response from '@web-std/fetch/src/response.js';
   import Headers from '@web-std/fetch/src/headers.js'; import {Blob} from '@web-std/blob';
   import {File} from '@web-std/file';import {FormData} from '@web-std/form-data';
   import * as events from './src/sandbox/guest-events.js';
   Object.assign(globalThis,{Request,Response,Headers,Blob,File,FormData,...events});`,
]
const output=[]
const packages=new Map()
for(const contents of stages){
  const result=await build({stdin:{contents,resolveDir:process.cwd()},bundle:true,write:false,
    format:'iife',platform:'browser',target:'es2022',alias:aliases,define:{global:'globalThis'},metafile:true,
    // Each guest context parses this source. Compact whitespace without
    // renaming functions/classes or applying syntax rewrites.
    minifyWhitespace:true,keepNames:true,
    plugins:[guestBufferPlugin(),streamFinishedPlugin(),{name:'web-util',setup(b){
      b.onResolve({filter:/^(process\/?|process\/browser(?:\.js)?|node:process)$/},()=>({path:resolve('src/compiler/shared-process.cjs')}))
      b.onLoad({filter:/@kayahr\/text-encoding\/lib\/main\/Text(?:Encoder|Decoder)\.js$/},args=>({
        contents:stageTextEncoding(readFileSync(args.path,'utf8'),args.path.endsWith('TextEncoder.js')?'TextEncoder':'TextDecoder'),loader:'js',resolveDir:dirname(args.path),
      }))
      b.onLoad({filter:/@web-std\/fetch\/src\/request\.js$/,namespace:'file'},args=>({
        contents:stageFetchRequest(readFileSync(args.path,'utf8')),loader:'js',resolveDir:dirname(args.path),
      }))
      b.onLoad({filter:/@web-std\/fetch\/src\/response\.js$/,namespace:'file'},args=>({
        contents:stageFetchResponse(readFileSync(args.path,'utf8')),loader:'js',resolveDir:dirname(args.path),
      }))
      b.onResolve({filter:/^events$/},()=>({path:resolve('src/compiler/shared-events.cjs')}))
      // The only crypto import in this data-type bundle is multipart randomness.
      // randombytes correctly throws without a guest CSPRNG. No fake entropy.
      b.onResolve({filter:/^crypto$/},()=>({path:'crypto',namespace:'web-crypto'}))
      b.onLoad({filter:/.*/,namespace:'web-crypto'},()=>({contents:`export {default as randomBytes} from 'randombytes';`,resolveDir:process.cwd()}))
      b.onResolve({filter:/^util$/},()=>({path:'util',namespace:'web-util'}))
      b.onLoad({filter:/.*/,namespace:'web-util'},()=>({contents:`import util from 'util/';
        export default util;export const types=util.types;
        export const TextEncoder=globalThis.TextEncoder,TextDecoder=globalThis.TextDecoder;
        export const promisify=util.promisify,inherits=util.inherits;`,resolveDir:process.cwd()}))
    }}]})
  output.push(result.outputFiles[0].text)
  for(const file of Object.keys(result.metafile.inputs)){
    if(!file.startsWith('node_modules/'))continue
    let directory=dirname(resolve(file))
    let pkg
    while(directory!==dirname(directory)){
      if(existsSync(join(directory,'package.json'))){
        const candidate=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'))
        if(candidate.name&&candidate.version){pkg=candidate;break}
      }
      directory=dirname(directory)
    }
    if(!pkg)throw new Error('Missing package metadata: '+file)
    addPackageNotices(packages,directory,pkg)
  }
}
mkdirSync(outputDirectory,{recursive:true})
const source=output.join('\n')
writeFileSync(join(outputDirectory,'globals.js'),source)
const dependencies=[...packages.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version))
writeFileSync(join(outputDirectory,'THIRD-PARTY-NOTICES.txt'),dependencies.map(x=>`${x.name}@${x.version}\nLicense: ${x.license}\n${x.notices}`).join('\n\n'))
writeFileSync(join(outputDirectory,'build.json'),JSON.stringify({sha256:createHash('sha256').update(source).digest('hex'),
  bytes:Buffer.byteLength(source),nativeAwait:true,networkTransport:false,
  minifyWhitespace:true,keepNames:true,
  stages:output.map((source,index)=>({name:['encoding-buffer-process','url-streams','fetch-data-types-events'][index],bytes:Buffer.byteLength(source)})),
  dependencies:dependencies.map(({notices,...x})=>x)},null,2)+'\n')
console.log('Built guest Web API implementations:',output.reduce((n,x)=>n+x.length,0),'characters')
