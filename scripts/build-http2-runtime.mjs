import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs'
import {resolve,join,relative,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {verifyNativeSourceRoot} from './verified-native-source.mjs'
const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)))
const sourceRoot=process.argv[2]??process.env.HTTP2_SOURCE_ROOT
const emccInput=process.argv[3]??process.env.EMCC
const outputInput=process.argv[4]??process.env.HTTP2_RUNTIME_OUTPUT
if(!sourceRoot||!emccInput)throw Error('Usage: HTTP2_SOURCE_ROOT=/path/to/nghttp2-1.70.0 EMCC=/path/to/emcc npm run build:http2-runtime')
const descriptorPath=join(projectRoot,'build-inputs/http2-source.json')
const helperPath=join(projectRoot,'scripts/verified-native-source.mjs')
const verified=verifyNativeSourceRoot(descriptorPath,sourceRoot)
const source={...verified.metadata,directory:verified.directory},lib=join(source.directory,'lib'),files=verified.sources
const emcc=resolve(emccInput),sdk=execFileSync(emcc,['--version'],{encoding:'utf8'})
if(!sdk.includes('5.0.1'))throw Error('Unexpected Emscripten')
const output=resolve(outputInput??join(projectRoot,'public/http2-runtime'));mkdirSync(output,{recursive:true})
const exports=['initialize','open','destroy','shutdown','count','goaway','headers','trailers','request','response','request_start','response_start','write','queued','consume','feed','send','reset','allocate','free','allocated','peak','error','pop','event_type','event_stream','event_flags','event_length','event_data'].map(name=>'_h2_'+name)
const common=['-std=c11','-I'+join(lib,'includes'),'-I'+lib,`-ffile-prefix-map=${source.directory}=/sources/nghttp2-1.70.0`,`-fmacro-prefix-map=${source.directory}=/sources/nghttp2-1.70.0`,`-ffile-prefix-map=${projectRoot}=/project`,`-fmacro-prefix-map=${projectRoot}=/project`,'-DHAVE_ARPA_INET_H=1','-DHAVE_NETINET_IN_H=1','-DHAVE_CLOCK_GETTIME=1','-DHAVE_DECL_CLOCK_MONOTONIC=1','-D_POSIX_C_SOURCE=200809L','-DNGHTTP2_STATICLIB=1']
const wrapper=join(projectRoot,'src/sandbox/http2-runtime.c')
const args=['-O2',...common,wrapper,...files,'-sMODULARIZE=1','-sEXPORT_ES6=1','-sENVIRONMENT=web,worker','-sFILESYSTEM=0','-sWASM_ASYNC_COMPILATION=0','-sALLOW_MEMORY_GROWTH=1','-sINITIAL_MEMORY=4194304','-sMAXIMUM_MEMORY=67108864','-sSTACK_SIZE=1048576','-sEXPORTED_FUNCTIONS='+JSON.stringify(exports),'-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]','-o',join(output,'http2.mjs')]
execFileSync(emcc,args,{stdio:'inherit',timeout:180000})
copyFileSync(verified.license,join(output,'LICENSE'))
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const posix=path=>path.split(sep).join('/'),recordPath=file=>file.startsWith(source.directory+sep)?`$SOURCE_ROOT/${posix(relative(source.directory,file))}`:posix(relative(projectRoot,file))
const recordArg=value=>value.replaceAll(output,'$OUTPUT_ROOT').replaceAll(source.directory,'$SOURCE_ROOT').replaceAll(projectRoot,'$PROJECT_ROOT')
const inputs=[fileURLToPath(import.meta.url),helperPath,descriptorPath,wrapper,...files,...verified.headers]
const report={source:verified.metadata,sdk,common:common.map(recordArg),files:files.map(recordPath),args:args.map(recordArg),hashes:Object.fromEntries(inputs.map(file=>[recordPath(file),hash(file)])),artifacts:{module:hash(join(output,'http2.mjs')),wasm:hash(join(output,'http2.wasm'))},wasmBytes:readFileSync(join(output,'http2.wasm')).length}
writeFileSync(join(output,'build.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({wasmBytes:report.wasmBytes,artifacts:report.artifacts},null,2))
