import {readFileSync,writeFileSync,mkdtempSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const runtime=JSON.parse(readFileSync('public/tls-runtime/build.json'))
const identity=JSON.parse(readFileSync('public/tls-probe/build.json'))
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
for(const [file,expected] of Object.entries(runtime.hashes))if(hash(file)!==expected)throw Error('TLS runtime build input changed: '+file)
const directory=mkdtempSync(join(tmpdir(),'tls-owned-native-')),library=join(runtime.source.directory,'library')
const args=['-std=c11','-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-I'+join(runtime.source.directory,'include'),'-I'+library,'-DMBEDTLS_USER_CONFIG_FILE="'+resolve('src/sandbox/tls-config.h')+'"','fixtures/tls-runtime-native.c',...readdirSync(library).filter(file=>file.endsWith('.c')).sort().map(file=>join(library,file)),'-o',join(directory,'probe')]
const compile=spawnSync('cc',args,{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024})
const execution=compile.status===0?spawnSync(join(directory,'probe'),['ca.pem','server.pem','server-key.pem'].map(name=>join(identity.directory,name)),{encoding:'utf8',timeout:120000,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}}):null
const summary=value=>value&&({status:value.status,signal:value.signal,stdout:value.stdout,stderr:value.stderr,error:String(value.error??'')})
const report={runtime,identity,directory,args,hashes:Object.fromEntries(['scripts/probe-tls-owned-native.mjs','fixtures/tls-runtime-native.c'].map(file=>[file,hash(file)])),compile:summary(compile),execution:summary(execution)}
writeFileSync('reports/tls-owned-native.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({compile:report.compile,execution:report.execution},null,2))
if(compile.status!==0||execution?.status!==0||execution.stderr)process.exitCode=1
