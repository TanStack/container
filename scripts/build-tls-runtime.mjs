import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs'
import {join,relative,resolve,sep} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {verifyNativeSourceRoot} from './verified-native-source.mjs'
const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)))
const sourceRoot=process.argv[2]??process.env.TLS_SOURCE_ROOT
const emccInput=process.argv[3]??process.env.EMCC
const outputInput=process.argv[4]??process.env.TLS_RUNTIME_OUTPUT
if(!sourceRoot||!emccInput)throw Error('Usage: TLS_SOURCE_ROOT=/path/to/mbedtls-3.6.7 EMCC=/path/to/emcc npm run build:tls-runtime')
const descriptorPath=join(projectRoot,'build-inputs/tls-source.json')
const helperPath=join(projectRoot,'scripts/verified-native-source.mjs')
const verified=verifyNativeSourceRoot(descriptorPath,sourceRoot)
const source={...verified.metadata,directory:verified.directory},library=join(source.directory,'library'),config=join(projectRoot,'src/sandbox/tls-config.h')
const files=verified.sources
const emcc=resolve(emccInput)
const sdk=execFileSync(emcc,['--version'],{encoding:'utf8'})
if(!sdk.includes('5.0.1'))throw Error('Unexpected Emscripten')
const output=resolve(outputInput??join(projectRoot,'public/tls-runtime'));mkdirSync(output,{recursive:true})
const exported=['initialize','allocate','deallocate','allocated','peak','shutdown','open','open_node','step','feed','drain','read','write','eof','close','destroy','verify','protocol','error'].map(name=>'_tls_'+name)
const wrapper=join(projectRoot,'src/sandbox/tls-runtime.c')
const args=['-O2','-std=c11','-I'+join(source.directory,'include'),'-I'+library,`-ffile-prefix-map=${source.directory}=/sources/mbedtls-3.6.7`,`-fmacro-prefix-map=${source.directory}=/sources/mbedtls-3.6.7`,`-ffile-prefix-map=${projectRoot}=/project`,`-fmacro-prefix-map=${projectRoot}=/project`,'-DMBEDTLS_USER_CONFIG_FILE="'+config+'"',wrapper,...files,
  '-sMODULARIZE=1','-sEXPORT_ES6=1','-sWASM_ASYNC_COMPILATION=0','-sENVIRONMENT=web,worker','-sFILESYSTEM=0','-sALLOW_MEMORY_GROWTH=1','-sINITIAL_MEMORY=4194304','-sMAXIMUM_MEMORY=67108864','-sSTACK_SIZE=1048576',
  '-sEXPORTED_FUNCTIONS='+JSON.stringify(exported),'-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]','-o',join(output,'tls.mjs')]
execFileSync(emcc,args,{stdio:'inherit',timeout:300000})
copyFileSync(verified.license,join(output,'LICENSE'))
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const posix=path=>path.split(sep).join('/'),recordPath=file=>file.startsWith(source.directory+sep)?`$SOURCE_ROOT/${posix(relative(source.directory,file))}`:posix(relative(projectRoot,file))
const recordArg=value=>value.replaceAll(output,'$OUTPUT_ROOT').replaceAll(source.directory,'$SOURCE_ROOT').replaceAll(projectRoot,'$PROJECT_ROOT')
const inputs=[fileURLToPath(import.meta.url),helperPath,descriptorPath,wrapper,config,...files,...verified.headers]
const build={source:verified.metadata,sdk,args:args.map(recordArg),hashes:Object.fromEntries(inputs.map(file=>[recordPath(file),hash(file)])),artifacts:{module:hash(join(output,'tls.mjs')),wasm:hash(join(output,'tls.wasm'))},wasmBytes:readFileSync(join(output,'tls.wasm')).length}
writeFileSync(join(output,'build.json'),JSON.stringify(build,null,2)+'\n')
console.log(JSON.stringify({wasmBytes:build.wasmBytes,artifacts:build.artifacts},null,2))
