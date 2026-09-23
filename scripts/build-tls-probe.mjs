import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync,copyFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {resolveEmscripten} from './fixture-toolchains.mjs'

const source=JSON.parse(readFileSync('reports/tls-source.json'))
if(source.version!=='3.6.7'||source.sha256!=='a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6')throw Error('Unexpected TLS source')
const directory=mkdtempSync(join(tmpdir(),'web-container-tls-build-'))
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:300000,maxBuffer:8*1024*1024})
const openssl=(...args)=>run('openssl',args)
// Disposable fixture identity. Never install this CA or use its key outside tests.
const caKey=join(directory,'ca-key.pem'),ca=join(directory,'ca.pem'),key=join(directory,'server-key.pem'),csr=join(directory,'server.csr'),cert=join(directory,'server.pem')
openssl('req','-x509','-newkey','rsa:2048','-nodes','-days','30','-subj','/CN=Sandbox TLS probe CA','-keyout',caKey,'-out',ca,'-addext','basicConstraints=critical,CA:TRUE')
openssl('req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',key,'-out',csr)
const extensions=join(directory,'server.ext')
writeFileSync(extensions,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n')
openssl('x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-set_serial','2','-days','30','-extfile',extensions,'-out',cert)
const header=join(directory,'tls-probe-certificates.h')
writeFileSync(header,[['ca_certificate',ca],['server_certificate',cert],['server_key',key]].map(([name,file])=>`static const unsigned char ${name}[]=${JSON.stringify(readFileSync(file,'utf8'))};`).join('\n'))
const config=resolve('fixtures/tls-probe-config.h')
const library=join(source.directory,'library')
const libraryFiles=readdirSync(library).filter(file=>file.endsWith('.c')).sort().map(file=>join(library,file))
const common=['-std=c11','-I'+join(source.directory,'include'),'-I'+library,'-I'+directory,'-DMBEDTLS_USER_CONFIG_FILE="'+config+'"',resolve('fixtures/tls-probe.c'),...libraryFiles]
console.log('Building native TLS probe with AddressSanitizer')
run('cc',['-O1','-g','-fsanitize=address','-fno-omit-frame-pointer',...common,'-o',join(directory,'probe')])
console.log('Building WASM TLS probe')
const output=resolve('public/tls-probe');mkdirSync(output,{recursive:true})
const emcc=resolveEmscripten()
const sdk=run(emcc,['--version'])
if(!sdk.includes('5.0.1'))throw Error('Unexpected Emscripten version')
const exported=['tls_probe','tls_peer_open','tls_peer_destroy','tls_peer_feed','tls_peer_drain','tls_peer_handshake','tls_peer_read','tls_peer_write','tls_peer_close','malloc','free'].map(name=>'_'+name)
run(emcc,['-O2',...common,'-sMODULARIZE=1','-sEXPORT_ES6=1','-sENVIRONMENT=web,worker,node','-sFILESYSTEM=0','-sALLOW_MEMORY_GROWTH=1','-sMAXIMUM_MEMORY=67108864','-sSTACK_SIZE=1048576','-sEXPORTED_FUNCTIONS='+JSON.stringify(exported),'-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]','-o',join(output,'tls.mjs')])
copyFileSync(join(source.directory,'LICENSE'),join(output,'LICENSE'))
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const inputs=['scripts/build-tls-probe.mjs','fixtures/tls-probe.c','fixtures/tls-probe-config.h',header,...libraryFiles,...readdirSync(join(source.directory,'include'),{recursive:true}).filter(file=>file.endsWith('.h')).sort().map(file=>join(source.directory,'include',file))]
const report={source,directory,compiler:run('cc',['--version']),sdk,hashes:Object.fromEntries(inputs.map(file=>[file,hash(file)])),artifacts:{module:hash(join(output,'tls.mjs')),wasm:hash(join(output,'tls.wasm'))},wasmBytes:readFileSync(join(output,'tls.wasm')).length}
writeFileSync(join(output,'build.json'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({directory,wasmBytes:report.wasmBytes,artifacts:report.artifacts},null,2))
