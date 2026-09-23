import {mkdtempSync,cpSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {stageModuleImportExports} from './stage-module-import-exports.mjs'
const directory=mkdtempSync(join(tmpdir(),'module-import-exports-native-'))
cpSync('.toolchains/quickjs-emscripten/vendor/quickjs',directory,{recursive:true})
stageModuleImportExports(join(directory,'quickjs.c'))
const wasm=process.argv.includes('--wasm')
const executable=join(directory,wasm?'probe.cjs':'probe')
execFileSync(wasm?resolve('.toolchains/emsdk/upstream/emscripten/emcc'):'cc',['-O1','-D_GNU_SOURCE','-DCONFIG_VERSION="probe"','-I'+directory,resolve('fixtures/module-import-exports-native.c'),...['quickjs','dtoa','libregexp','libunicode','cutils'].map(name=>join(directory,name+'.c')),'-lm',...(wasm?['-sALLOW_MEMORY_GROWTH=1','-sSTACK_SIZE=1048576']:[]),'-o',executable],{stdio:'inherit'})
execFileSync(wasm?process.execPath:executable,wasm?[executable]:[],{stdio:'inherit'})
console.log(JSON.stringify({directory,passed:true,cases:['cycle-call','alias','live-update','namespace','diamond','ambiguous','missing','circular','TDZ']}))
