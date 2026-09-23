import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {sourcePositionCacheSource} from './stage-source-position-cache.mjs'

const sourcePath=process.argv[2]??'/private/tmp/quickjs-als-engine-spike/vendor/quickjs/quickjs.c'
const source=readFileSync(sourcePath,'utf8')
const type=source.match(/typedef struct \{\n    \/\* last source position \*\/[\s\S]*?\} GetLineColCache;/)?.[0]
const start=source.indexOf('static int get_line_col(int *pcol_num,')
const end=source.indexOf("/* 'ptr' is the position of the error",start)
if(!type||start<0||end<start)throw Error('QuickJS source-position implementation not found')
const original=source.slice(start,end)
const staged=sourcePositionCacheSource(source)
const stagedType=staged.match(/typedef struct \{\n    \/\* last source position \*\/[\s\S]*?\} GetLineColCache;/)[0]
const stagedFunctions=staged.slice(staged.indexOf('static int get_line_col(int *pcol_num,'),staged.indexOf("/* 'ptr' is the position of the error"))
const stagedCode=(stagedType+'\n'+stagedFunctions).replaceAll('GetLineColCache','StagedCache').replaceAll('get_line_col','staged_get_line_col').replace('    for(i = 0; i < len; i++) {','    scanned_bytes += len;\n    for(i = 0; i < len; i++) {')
const instrumented=original.replace('    for(i = 0; i < len; i++) {','    scanned_bytes += len;\n    for(i = 0; i < len; i++) {')
if(instrumented===original)throw Error('Scan counter insertion failed')
const fixture=readFileSync('fixtures/source-position-cache.c','utf8')
const directory=mkdtempSync(join(tmpdir(),'source-position-cache-'))
const c=join(directory,'probe.c'),binary=join(directory,'probe')
writeFileSync(c,fixture.replace('/* ORIGINAL_CACHE */','static uint64_t scanned_bytes;\n'+type+'\n'+instrumented+'\n'+stagedCode))
execFileSync('cc',['-O2','-Wall','-Wextra','-Werror',c,'-o',binary],{stdio:'inherit'})
const result=JSON.parse(execFileSync(binary,{encoding:'utf8',timeout:60000}))
const hash=value=>createHash('sha256').update(value).digest('hex')
const report={sourcePath,sourceSHA256:hash(source),fixtureSHA256:hash(fixture),stageSHA256:hash(readFileSync('scripts/stage-source-position-cache.mjs')),scope:'Native lookup microbenchmark and staged C comparison, not browser performance',...result}
writeFileSync('reports/source-position-cache.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
