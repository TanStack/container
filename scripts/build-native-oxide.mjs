import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {constants,copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs'
import {dirname,join,relative,resolve,sep} from 'node:path'
import {homedir,tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {supplementalRustNotice} from './supplemental-rust-notices.mjs'

const root=fileURLToPath(new URL('..',import.meta.url))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=path=>JSON.parse(readFileSync(path,'utf8'))
const noticeName=/^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i

export function oxideBuildInputs(projectRoot=root){
  const inputs=json(join(projectRoot,'build-inputs/native-oxide.json'))
  assert.equal(inputs.format,1,'Unsupported native Oxide input format')
  assert.equal(hash(readFileSync(join(projectRoot,inputs.patch))),inputs.patchSHA256,'Native Oxide patch changed')
  assert.equal(hash(readFileSync(join(projectRoot,'tests/fixtures/native-oxide-build/package-lock.json'))),
    inputs.toolchainLockSHA256,'Native Oxide toolchain lock changed')
  return inputs
}

export function verifyOxideArchiveEntries(entries,prefix){
  assert(entries.length>0,'Empty native Oxide source archive')
  for(const name of entries){
    assert(!name.includes('\\')&&name.split('/').every(part=>part!=='.'&&part!=='..')&&
      (name===prefix+'/'||name.startsWith(prefix+'/')),'Unsafe native Oxide archive path: '+name)
  }
}

export function oxideWasmIdentity(bytes){
  const module=new WebAssembly.Module(bytes)
  return {bytes:bytes.length,sha256:hash(bytes),
    imports:WebAssembly.Module.imports(module),exports:WebAssembly.Module.exports(module)}
}

export function verifyOxideBindingInterface(actual,expected){
  // JavaScript resolves imports by module/name and exports by name. Linker
  // indices can differ between build hosts without changing that interface.
  // Keep every descriptor and duplicate, and never rewrite the build record.
  const sorted=entries=>entries.toSorted((left,right)=>{
    const a=JSON.stringify([left.module??null,left.name,left.kind])
    const b=JSON.stringify([right.module??null,right.name,right.kind])
    return a<b?-1:a>b?1:0
  })
  assert.deepEqual(sorted(actual.imports),sorted(expected.imports),'Rebuilt native Oxide imports differ from its pinned JS binding')
  assert.deepEqual(sorted(actual.exports),sorted(expected.exports),'Rebuilt native Oxide exports differ from its pinned JS binding')
}

export function verifyNativeOxideBuild(directory,projectRoot=root){
  const inputs=oxideBuildInputs(projectRoot),record=json(join(directory,'BUILD.json'))
  assert.equal(record.format,1,'Invalid native Oxide build record')
  assert.deepEqual(record.inputs,inputs,'Native Oxide source inputs do not match this checkout')
  assert.equal(record.compiler.version,inputs.rustVersion,'Native Oxide Rust version mismatch')
  assert.equal(record.compiler.commit,inputs.rustCommit,'Native Oxide Rust commit mismatch')
  assert.deepEqual(oxideWasmIdentity(readFileSync(join(directory,'tailwindcss-oxide.wasm32-wasi.wasm'))),
    record.wasm,'Native Oxide WASM does not match its build record')
  const dependencies=readFileSync(join(directory,'RUST-INPUTS.json'))
  const notices=readFileSync(join(directory,'RUST-NOTICES.txt'))
  assert.equal(hash(dependencies),record.rustInputsSHA256,'Native Oxide Rust inventory changed')
  assert.equal(hash(notices),record.rustNoticesSHA256,'Native Oxide Rust notices changed')
  return record
}

export function cargoRegistryChecksums(lock){
  const result=new Map()
  for(const block of lock.split('[[package]]').slice(1)){
    const name=block.match(/^name = "([^"]+)"$/m)?.[1]
    const version=block.match(/^version = "([^"]+)"$/m)?.[1]
    const source=block.match(/^source = "([^"]+)"$/m)?.[1]
    if(!source?.startsWith('registry+'))continue
    const checksum=block.match(/^checksum = "([a-f0-9]{64})"$/m)?.[1]
    assert(checksum,'Missing locked Cargo checksum: '+name)
    result.set(name+'@'+version,checksum)
  }
  return result
}

function verifyRegistryPackage(pkg,checksums,scratch){
  const directory=dirname(pkg.manifest_path),checksum=checksums.get(pkg.name+'@'+pkg.version)
  assert(checksum,'Compiled Rust input is not in Cargo.lock: '+pkg.name)
  const registry=dirname(directory),registryRoot=dirname(registry)
  const archive=join(dirname(registryRoot),'cache',registry.split(sep).at(-1),`${pkg.name}-${pkg.version}.crate`)
  assert.equal(hash(readFileSync(archive)),checksum,'Cargo registry archive changed: '+pkg.name)
  const prefix=pkg.name+'-'+pkg.version,verified=join(scratch,prefix)
  if(!existsSync(verified)){
    const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:16*1024*1024}).trim().split('\n')
    verifyOxideArchiveEntries(entries,prefix)
    const types=execFileSync('tar',['-tvzf',archive],{encoding:'utf8',maxBuffer:16*1024*1024}).trim().split('\n')
    assert(types.every(line=>line[0]==='-'||line[0]==='d'),'Cargo archive contains special files: '+pkg.name)
    execFileSync('tar',['-xzf',archive,'-C',scratch],{stdio:'pipe'})
  }
  function visit(folder,prefix=''){
    const installedFolder=join(directory,prefix)
    assert.deepEqual(readdirSync(installedFolder).filter(name=>prefix!==''||name!=='.cargo-ok').sort(),
      readdirSync(folder).sort(),'Unlisted Cargo registry source: '+pkg.name+'/'+prefix)
    for(const name of readdirSync(folder)){
      const path=prefix?prefix+'/'+name:name,file=join(folder,name),stat=lstatSync(file)
      assert(!stat.isSymbolicLink(),'Cargo archive contains a link')
      if(stat.isDirectory())visit(file,path)
      else{
        const installed=join(directory,path)
        assert(lstatSync(installed).isFile()&&!lstatSync(installed).isSymbolicLink(),'Invalid Cargo source: '+path)
        assert.equal(hash(readFileSync(installed)),hash(readFileSync(file)),'Cargo registry source changed: '+pkg.name+'/'+path)
      }
    }
  }
  visit(verified)
  return checksum
}

function rustInventory(metadata,artifacts,source,inputs,checksums,registryScratch,projectRoot){
  const byId=new Map(metadata.packages.map(pkg=>[pkg.id,pkg]))
  const used=new Map()
  for(const artifact of artifacts){
    const pkg=byId.get(artifact.package_id)
    assert(pkg,'Unknown compiled Rust input: '+artifact.package_id)
    const record=used.get(pkg.id)??{pkg,roles:new Set(),features:new Set(),platforms:new Set()}
    record.roles.add(artifact.target.kind.includes('custom-build')?'build-script':
      artifact.target.kind.includes('proc-macro')?'proc-macro':'library')
    for(const feature of artifact.features)record.features.add(feature)
    record.platforms.add(artifact.filenames.some(path=>path.includes('/'+inputs.target+'/'))?inputs.target:'host')
    used.set(pkg.id,record)
  }
  const texts=[]
  const packages=[...used.values()].map(({pkg,roles,features,platforms})=>{
    const packageRoot=dirname(pkg.manifest_path),workspace=!pkg.source
    assert(!workspace||relative(source,packageRoot).split(sep)[0]!=='..','Rust workspace input escaped source')
    const archiveSHA256=workspace?undefined:verifyRegistryPackage(pkg,checksums,registryScratch)
    const paths=new Set(readdirSync(packageRoot).filter(name=>noticeName.test(name)&&lstatSync(join(packageRoot,name)).isFile()).map(name=>join(packageRoot,name)))
    if(pkg.license_file)paths.add(resolve(packageRoot,pkg.license_file))
    if(workspace&&paths.size===0)paths.add(join(source,'LICENSE'))
    const notices=[...paths].sort().map(path=>{
      const bytes=readFileSync(path)
      texts.push(`${pkg.name}@${pkg.version}\nDeclared license: ${pkg.license??'not declared'}\n${bytes.toString('utf8')}`)
      return {path:path===join(source,'LICENSE')?'LICENSE':relative(packageRoot,path).split(sep).join('/'),sha256:hash(bytes)}
    })
    if(!notices.length&&!workspace){
      const supplemental=supplementalRustNotice(packageRoot,pkg,archiveSHA256,projectRoot)
      if(supplemental){
        texts.push(`${pkg.name}@${pkg.version}\nDeclared license: ${pkg.license}\nUpstream notice: ${supplemental.source}\n${supplemental.text}`)
        const {path,sha256,source:noticeSource,revision,revisionEvidence}=supplemental
        notices.push({path,sha256,supplemental:true,source:noticeSource,revision,revisionEvidence})
      }
    }
    if(!notices.length)texts.push(`${pkg.name}@${pkg.version}\nDeclared license: ${pkg.license??'not declared'}\nNo notice text found. Distribution review remains open.`)
    return {name:pkg.name,version:pkg.version,source:pkg.source??'workspace',
      ...(workspace?{revision:inputs.revision}:{archiveSHA256}),
      license:pkg.license??null,roles:[...roles].sort(),platforms:[...platforms].sort(),features:[...features].sort(),notices}
  }).sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version))
  // These are the packages Cargo actually compiled, not a claim that every byte
  // in every package was linked into WASM. Host build tools remain in the record.
  return {inventory:{format:1,scope:'Cargo compiler artifacts, including host build tools and proc macros',
    exactLinkedContents:false,packages,missingNoticeText:packages.filter(pkg=>!pkg.notices.length).map(pkg=>pkg.name+'@'+pkg.version)},
    notices:texts.sort().join('\n\n')+'\n'}
}

export async function buildNativeOxide({projectRoot=root,output,sourceArchive=process.env.NATIVE_OXIDE_SOURCE_ARCHIVE,
  offline=process.env.NATIVE_OXIDE_OFFLINE==='1'}={}){
  projectRoot=resolve(projectRoot)
  const inputs=oxideBuildInputs(projectRoot)
  assert(output,'Native Oxide requires a new output directory')
  output=resolve(output)
  assert(!existsSync(output),'Native Oxide output exists; choose a new directory')
  const compiler=execFileSync('rustc',[`+${inputs.rustVersion}`,'--version','--verbose'],{encoding:'utf8'})
  assert(compiler.includes(`release: ${inputs.rustVersion}\n`)&&compiler.includes(`commit-hash: ${inputs.rustCommit}\n`),
    'Install the pinned Rust toolchain before building native Oxide')
  const targets=execFileSync('rustup',['target','list','--toolchain',inputs.rustVersion,'--installed'],{encoding:'utf8'}).trim().split('\n')
  assert(targets.includes(inputs.target),'Install the pinned Rust WASI threads target before building native Oxide')
  const tools=join(projectRoot,'tests/fixtures/native-oxide-build/node_modules/emnapi')
  assert.equal(json(join(tools,'package.json')).version,inputs.emnapiVersion,'Install the locked native Oxide build fixture first')
  const linkDirectory=join(tools,'lib',inputs.target)
  assert.equal(hash(readFileSync(join(linkDirectory,'libemnapi-basic-mt.a'))),inputs.emnapiLibrarySHA256,'Native Oxide emnapi library changed')
  assert(!process.env.RUSTFLAGS&&!process.env.CARGO_ENCODED_RUSTFLAGS,'Native Oxide requires its own pinned Rust flags')
  const scratch=mkdtempSync(join(tmpdir(),'container-native-oxide-source-'))
  let archive
  if(sourceArchive)archive=readFileSync(resolve(sourceArchive))
  else{
    const response=await fetch(inputs.sourceURL,{signal:AbortSignal.timeout(120000)})
    assert(response.ok,'Native Oxide source download failed: '+response.status)
    archive=Buffer.from(await response.arrayBuffer())
  }
  assert.equal(hash(archive),inputs.archiveSHA256,'Native Oxide source archive changed')
  const archivePath=join(scratch,'source.tar.gz')
  writeFileSync(archivePath,archive,{flag:'wx'})
  const entries=execFileSync('tar',['-tzf',archivePath],{encoding:'utf8',maxBuffer:16*1024*1024}).trim().split('\n')
  verifyOxideArchiveEntries(entries,inputs.archivePrefix)
  const types=execFileSync('tar',['-tvzf',archivePath],{encoding:'utf8',maxBuffer:16*1024*1024}).trim().split('\n')
  assert(types.every(line=>line[0]==='-'||line[0]==='d'),'Native Oxide archive contains links or special files')
  execFileSync('tar',['-xzf',archivePath,'-C',scratch],{stdio:'pipe'})
  const source=realpathSync(join(scratch,inputs.archivePrefix))
  assert.equal(hash(readFileSync(join(source,'Cargo.lock'))),inputs.cargoLockSHA256,'Native Oxide Cargo lock changed')
  assert.equal(hash(readFileSync(join(source,inputs.patchedFile))),inputs.beforeSHA256,'Native Oxide patch source changed')
  execFileSync('patch',['--batch','--fuzz=0','-p1','-i',join(projectRoot,inputs.patch)],{cwd:source,stdio:'pipe'})
  assert.equal(hash(readFileSync(join(source,inputs.patchedFile))),inputs.afterSHA256,'Native Oxide patched source changed')
  const cargoHome=realpathSync(resolve(process.env.CARGO_HOME??join(homedir(),'.cargo')))
  const flags=[`--remap-path-prefix=${source}=/tanstack-container/oxide`,
    `--remap-path-prefix=${cargoHome}/registry=/cargo/registry`]
  const environment={...process.env,EMNAPI_LINK_DIR:linkDirectory,CARGO_TARGET_DIR:join(scratch,'target'),
    CARGO_NET_OFFLINE:'true',CARGO_ENCODED_RUSTFLAGS:flags.join('\x1f')}
  if(!offline)execFileSync('cargo',[`+${inputs.rustVersion}`,'fetch','--locked'],
    {cwd:source,env:{...environment,CARGO_NET_OFFLINE:'false'},stdio:'inherit'})
  const metadata=JSON.parse(execFileSync('cargo',[`+${inputs.rustVersion}`,'metadata','--offline','--locked',
    '--format-version','1','--filter-platform',inputs.target],{cwd:source,env:environment,encoding:'utf8',maxBuffer:64*1024*1024}))
  const checksums=cargoRegistryChecksums(readFileSync(join(source,'Cargo.lock'),'utf8'))
  const registryScratch=join(scratch,'verified-registry')
  mkdirSync(registryScratch)
  // Check registry source bytes before the compiler runs, not just after it.
  for(const pkg of metadata.packages)if(pkg.source?.startsWith('registry+'))verifyRegistryPackage(pkg,checksums,registryScratch)
  console.log('Compiling native Oxide from pinned Rust source')
  const messages=execFileSync('cargo',[`+${inputs.rustVersion}`,'build','--offline','--locked','--release',
    '--target',inputs.target,'-p',inputs.package,'-j1','--message-format=json-render-diagnostics'],
    {cwd:source,env:environment,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','inherit']})
  const artifacts=messages.trim().split('\n').map(line=>JSON.parse(line)).filter(message=>message.reason==='compiler-artifact')
  assert(artifacts.some(artifact=>artifact.target.kind.includes('cdylib')&&artifact.target.name==='tailwind_oxide'),'Missing native Oxide compiler artifact')
  const bytes=readFileSync(join(scratch,'target',inputs.target,'release/tailwind_oxide.wasm'))
  const {inventory,notices}=rustInventory(metadata,artifacts,source,inputs,checksums,registryScratch,projectRoot)
  const inventoryBytes=Buffer.from(JSON.stringify(inventory,null,2)+'\n')
  const sysroot=execFileSync('rustc',[`+${inputs.rustVersion}`,'--print','sysroot'],{encoding:'utf8'}).trim()
  const standardLibrary=join(sysroot,'lib/rustlib',inputs.target,'lib')
  const record={format:1,inputs,compiler:{version:inputs.rustVersion,commit:inputs.rustCommit,
    host:compiler.match(/^host: (.+)$/m)[1],flags:flags.map(flag=>flag.replace(source,'SOURCE').replace(cargoHome,'CARGO_HOME')),
    standardLibrary:readdirSync(standardLibrary).sort().filter(name=>lstatSync(join(standardLibrary,name)).isFile()).map(name=>({name,sha256:hash(readFileSync(join(standardLibrary,name)))}))},
    wasm:oxideWasmIdentity(bytes),rustInputsSHA256:hash(inventoryBytes),rustNoticesSHA256:hash(notices)}
  mkdirSync(output,{recursive:true})
  writeFileSync(join(output,'tailwindcss-oxide.wasm32-wasi.wasm'),bytes,{flag:'wx'})
  writeFileSync(join(output,'BUILD.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'})
  writeFileSync(join(output,'RUST-INPUTS.json'),inventoryBytes,{flag:'wx'})
  writeFileSync(join(output,'RUST-NOTICES.txt'),notices,{flag:'wx'})
  verifyNativeOxideBuild(output,projectRoot)
  return record
}

export function installNativeOxideBuild(directory,oxideRoot,projectRoot=root){
  const record=verifyNativeOxideBuild(directory,projectRoot)
  const upstream=oxideWasmIdentity(readFileSync(join(oxideRoot,'tailwindcss-oxide.wasm32-wasi.wasm')))
  verifyOxideBindingInterface(record.wasm,upstream)
  copyFileSync(join(directory,'tailwindcss-oxide.wasm32-wasi.wasm'),join(oxideRoot,'tailwindcss-oxide.wasm32-wasi.wasm'))
  for(const file of ['BUILD.json','RUST-INPUTS.json','RUST-NOTICES.txt'])
    copyFileSync(join(directory,file),join(oxideRoot,file),constants.COPYFILE_EXCL)
  return record
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,3,'Usage: node scripts/build-native-oxide.mjs NEW_OUTPUT_DIRECTORY')
  const record=await buildNativeOxide({output:process.argv[2]})
  console.log('NATIVE_OXIDE_BUILD='+JSON.stringify({directory:resolve(process.argv[2]),sha256:record.wasm.sha256}))
}
