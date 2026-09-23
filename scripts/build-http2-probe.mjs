import {readFileSync,writeFileSync,mkdirSync,readdirSync,copyFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolveEmscripten} from './fixture-toolchains.mjs'
const source=JSON.parse(readFileSync('reports/http2-source.json','utf8'))
if(source.version!=='1.70.0'||source.sha256!=='8faca1f78aa99ac3bc1768a76b7e0f6b36d8e6a62c13818751b1d205f02f9405')throw Error('Unexpected HTTP/2 source')
const lib=join(source.directory,'lib'),files=readdirSync(lib).filter(file=>file.endsWith('.c')).sort().map(file=>join(lib,file))
const emcc=resolveEmscripten(),sdk=execFileSync(emcc,['--version'],{encoding:'utf8'})
if(!sdk.includes('5.0.1'))throw Error('Unexpected Emscripten')
const output=resolve('public/http2-probe');mkdirSync(output,{recursive:true})
const exports=['init','close','request','response','request_start','response_start','write','queued','consume','feed','send','reset','allocate','free','allocated','peak','error','pop','event_type','event_stream','event_flags','event_length','event_data'].map(name=>'_h2_'+name)
const common=['-std=c11','-I'+join(lib,'includes'),'-I'+lib,'-DHAVE_ARPA_INET_H=1','-DHAVE_NETINET_IN_H=1','-DHAVE_CLOCK_GETTIME=1','-DHAVE_DECL_CLOCK_MONOTONIC=1','-D_POSIX_C_SOURCE=200809L','-DNGHTTP2_STATICLIB=1']
const args=['-O2',...common,resolve('src/sandbox/http2-probe.c'),...files,'-sMODULARIZE=1','-sEXPORT_ES6=1','-sENVIRONMENT=web,worker','-sFILESYSTEM=0','-sALLOW_MEMORY_GROWTH=1','-sINITIAL_MEMORY=4194304','-sMAXIMUM_MEMORY=67108864','-sSTACK_SIZE=1048576','-sEXPORTED_FUNCTIONS='+JSON.stringify(exports),'-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]','-o',join(output,'http2.mjs')]
execFileSync(emcc,args,{stdio:'inherit',timeout:180000})
copyFileSync(join(source.directory,'COPYING'),join(output,'LICENSE'))
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const inputs=['scripts/build-http2-probe.mjs','src/sandbox/http2-probe.c',...files,...readdirSync(lib,{recursive:true}).filter(file=>file.endsWith('.h')).sort().map(file=>join(lib,file))]
const report={source,sdk,common,files,args,hashes:Object.fromEntries(inputs.map(file=>[file,hash(file)])),artifacts:{module:hash(join(output,'http2.mjs')),wasm:hash(join(output,'http2.wasm'))},wasmBytes:readFileSync(join(output,'http2.wasm')).length}
writeFileSync(join(output,'build.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({wasmBytes:report.wasmBytes,artifacts:report.artifacts},null,2))
