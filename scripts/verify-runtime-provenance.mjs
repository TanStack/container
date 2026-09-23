import {createHash} from 'node:crypto'
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join,relative,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {inspectSDKBuildProfile} from './sdk-build-profiles.mjs'

const sha256=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const posix=path=>path.split('\\').join('/')
const json=path=>JSON.parse(readFileSync(path,'utf8'))
function files(directory){
  const out=[]
  for(const name of readdirSync(directory).sort()){
    const path=join(directory,name),entry=statSync(path)
    if(entry.isDirectory())out.push(...files(path));else if(entry.isFile())out.push(path)
  }
  return out
}
function requireFile(path,errors,label){if(!existsSync(path)){errors.push(`${label}: missing ${path}`);return false}return true}
function artifactList(root,directory){return files(directory).map(path=>({path:posix(relative(root,path)),bytes:statSync(path).size,sha256:sha256(path)}))}
function hashMatches(path,expected,errors,label){
  if(!requireFile(path,errors,label))return
  const actual=sha256(path);if(actual!==expected)errors.push(`${label}: expected ${expected}, got ${actual}`)
}

export function verifyRuntimeProvenance(projectRoot=resolve('.'),options={}){
  const publicRoot=join(projectRoot,'public'),errors=[]
  const engines=inspectSDKBuildProfile(publicRoot,'default')
  const engineDirectories=[...new Set(Object.values(engines).map(engine=>engine.sourceDirectory))].sort()
  const specs=[
    {id:'esbuild-wasm',directory:join(projectRoot,'node_modules/esbuild-wasm'),artifacts:['esbuild.wasm'],licenses:['LICENSE.md'],command:null,reason:'The npm package ships an upstream prebuilt binary, its source checkout and Go toolchain are not part of this repository.'},
    ...engineDirectories.map(name=>({id:`quickjs:${name}`,directory:join(publicRoot,name),artifacts:null,licenses:['QUICKJS-LICENSE','WRAPPER-LICENSE'],metadata:'build.json',command:'node scripts/build-quickjs-als.mjs',reason:'The pinned QuickJS and Emscripten source work directories recorded by this build are not checked in.'})),
    {id:'mvdan-shell',directory:join(publicRoot,'mvdan-shell'),artifacts:null,licenses:['MVDAN-LICENSE','GO-LICENSE'],metadata:'build.json',command:'node scripts/build-mvdan-shell.mjs <offline-toolchain>',reason:'The pinned Go toolchain argument and populated offline module cache are not checked in.'},
    {id:'tls-runtime',directory:join(publicRoot,'tls-runtime'),artifacts:null,licenses:['LICENSE'],metadata:'build.json',command:'node scripts/build-tls-runtime.mjs <source-directory>',reason:'The hash-pinned Mbed TLS source archive and extracted source directory are not checked in.'},
    {id:'http2-runtime',directory:join(publicRoot,'http2-runtime'),artifacts:null,licenses:['LICENSE'],metadata:'build.json',command:'node scripts/build-http2-runtime.mjs <source-directory>',reason:'The hash-pinned nghttp2 source archive and extracted source directory are not checked in.'},
    {id:'kernel-runtime',directory:join(publicRoot,'kernel-runtime'),artifacts:null,licenses:['THIRD-PARTY-NOTICES.txt','ZLIB-NOTICES.txt'],metadata:'build.json',command:'node scripts/build-kernel-builtins.mjs',reason:null},
    {id:'vm-web-apis',directory:join(publicRoot,'vm-web-apis'),artifacts:null,licenses:['THIRD-PARTY-NOTICES.txt'],metadata:'build.json',command:'node scripts/build-vm-web-apis.mjs',reason:null},
  ]
  const groups=[]
  for(const spec of specs){
    if(!requireFile(spec.directory,errors,spec.id))continue
    const all=artifactList(projectRoot,spec.directory)
    for(const license of spec.licenses)requireFile(join(spec.directory,license),errors,`${spec.id} license`)
    const metadata=spec.metadata&&requireFile(join(spec.directory,spec.metadata),errors,`${spec.id} metadata`)?json(join(spec.directory,spec.metadata)):null
    if(spec.artifacts)for(const name of spec.artifacts)requireFile(join(spec.directory,name),errors,`${spec.id} artifact`)
    if(spec.id==='mvdan-shell'&&metadata){hashMatches(join(projectRoot,'shell/mvdan/main.go'),metadata.sourceSHA256,errors,'mvdan source');hashMatches(join(projectRoot,'shell/mvdan/go.sum'),metadata.lockSHA256,errors,'mvdan lock');hashMatches(join(spec.directory,'shell.wasm'),metadata.wasmSHA256,errors,'mvdan wasm')}
    if(spec.id==='vm-web-apis'&&metadata)hashMatches(join(spec.directory,'globals.js'),metadata.sha256,errors,'vm-web-apis bundle')
    if(spec.id==='kernel-runtime'&&metadata)hashMatches(join(spec.directory,'builtins.json'),metadata.sha256,errors,'kernel builtins')
    if(spec.id==='tls-runtime'&&metadata){hashMatches(join(spec.directory,'tls.mjs'),metadata.artifacts?.module,errors,'TLS module');hashMatches(join(spec.directory,'tls.wasm'),metadata.artifacts?.wasm,errors,'TLS wasm');hashMatches(join(spec.directory,'LICENSE'),metadata.source?.licenseSHA256,errors,'TLS license')}
    if(spec.id==='http2-runtime'&&metadata){hashMatches(join(spec.directory,'http2.mjs'),metadata.artifacts?.module,errors,'HTTP/2 module');hashMatches(join(spec.directory,'http2.wasm'),metadata.artifacts?.wasm,errors,'HTTP/2 wasm');hashMatches(join(spec.directory,'LICENSE'),metadata.source?.licenseSHA256,errors,'HTTP/2 license')}
    if(spec.id.startsWith('quickjs:')&&metadata){const wasm=all.find(x=>x.path.endsWith('.wasm'));if(!wasm)errors.push(`${spec.id}: missing wasm artifact`);else if(metadata.wasmSha256!==wasm.sha256)errors.push(`${spec.id}: stale wasmSha256`)}
    groups.push({id:spec.id,artifacts:all,metadata:spec.metadata?posix(relative(projectRoot,join(spec.directory,spec.metadata))):null,licenses:spec.licenses.map(x=>posix(relative(projectRoot,join(spec.directory,x)))),toolchain:metadata?.sdk??metadata?.version??(spec.id==='esbuild-wasm'?json(join(spec.directory,'package.json')).version:process.version),flags:metadata?.args??metadata?.goBuild??null,rebuild:{command:spec.command,available:!spec.reason,unavailableReason:spec.reason}})
  }
  if(options.rebuild){
    const temporary=mkdtempSync(join(tmpdir(),'runtime-provenance-'))
    try{
      const rebuilt=join(temporary,'vm-web-apis')
      execFileSync(process.execPath,['scripts/build-vm-web-apis.mjs'],{cwd:projectRoot,env:{...process.env,VM_WEB_APIS_OUTPUT:rebuilt},stdio:'pipe'})
      const expected=artifactList(projectRoot,join(publicRoot,'vm-web-apis')).map(x=>[x.path.split('/').at(-1),x.sha256])
      const actual=artifactList(temporary,rebuilt).map(x=>[x.path.split('/').at(-1),x.sha256])
      if(JSON.stringify(actual)!==JSON.stringify(expected))errors.push('vm-web-apis: clean temporary rebuild did not byte-match shipped artifacts')
      const group=groups.find(x=>x.id==='vm-web-apis');group.rebuild.byteCompared=true
    }finally{rmSync(temporary,{recursive:true,force:true})}
  }
  const report={format:1,scope:'Default standalone SDK generated and native runtime provenance',groups,summary:{groups:groups.length,artifacts:groups.reduce((n,g)=>n+g.artifacts.length,0),errors:errors.length},errors}
  return report
}

export function renderRuntimeProvenance(report){
  const lines=['# Runtime provenance','',`Verified ${report.summary.groups} runtime groups and ${report.summary.artifacts} files.`,'','| Group | Files | Local rebuild |','| --- | ---: | --- |']
  for(const group of report.groups)lines.push(`| ${group.id} | ${group.artifacts.length} | ${group.rebuild.available?'Available':group.rebuild.unavailableReason} |`)
  lines.push('','## Verification result','',report.errors.length?report.errors.map(x=>`- ${x}`).join('\n'):'All recorded hashes, licenses, metadata, and artifact coverage passed.','')
  return lines.join('\n')
}

if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
  const root=resolve('.'),report=verifyRuntimeProvenance(root,{rebuild:true}),out=join(root,'reports')
  writeFileSync(join(out,'runtime-provenance.json'),JSON.stringify(report,null,2)+'\n')
  writeFileSync(join(out,'runtime-provenance.md'),renderRuntimeProvenance(report))
  if(report.errors.length){console.error(report.errors.join('\n'));process.exitCode=1}else console.log(`Runtime provenance passed: ${report.summary.groups} groups, ${report.summary.artifacts} files`)
}
