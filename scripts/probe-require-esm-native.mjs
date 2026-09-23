import {mkdtempSync,cpSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {stageRequireESM} from './stage-require-esm.mjs'
const directory=mkdtempSync(join(tmpdir(),'require-esm-native-'))
cpSync('.toolchains/quickjs-emscripten/vendor/quickjs',directory,{recursive:true})
stageRequireESM(join(directory,'quickjs.c'))
const wasm=process.argv.includes('--wasm')
const exe=join(directory,wasm?'probe.cjs':'probe')
execFileSync(wasm?resolve('.toolchains/emsdk/upstream/emscripten/emcc'):'cc',['-O1','-D_GNU_SOURCE','-DCONFIG_VERSION="probe"','-I'+directory,resolve('fixtures/require-esm-native.c'),...['quickjs','dtoa','libregexp','libunicode','cutils'].map(name=>join(directory,name+'.c')),'-lm',...(wasm?['-sALLOW_MEMORY_GROWTH=1','-sSTACK_SIZE=1048576']:[]),'-o',exe],{stdio:'inherit'})
execFileSync(wasm?process.execPath:exe,wasm?[exe]:[],{stdio:'inherit'})
console.log('require ESM native identity, live binding, TLA, cycle, error and job isolation checks passed')
