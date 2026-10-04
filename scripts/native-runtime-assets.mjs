import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {constants,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync} from 'node:fs'
import {dirname,join,relative,resolve,sep} from 'node:path'
import {verifyNativeOxideBuild} from './build-native-oxide.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const required=['engine.js','filesystem-owner.mjs','esbuild.wasm','rolldown-binding.wasm32-wasi.wasm',
  'lightningcss_node.wasm','lightningcss-1.32.0.wasm',
  'oxide/oxide.mjs','oxide/tailwindcss-oxide.wasm32-wasi.wasm',
  'SHIPPED-INPUTS.json','THIRD-PARTY-NOTICES.txt']

export function nativeRuntimePackageVersion(evidence,name){
  const versions=[...new Set(evidence.packages.filter(item=>item.name===name).map(item=>item.version))]
  assert(versions.length===1&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versions[0]),
    'Native runtime requires one exact package version: '+name)
  return versions[0]
}

export function nativeRuntimeToolchain(evidence){
  const toolchain={vite:nativeRuntimePackageVersion(evidence,'vite'),
    rolldown:nativeRuntimePackageVersion(evidence,'@rolldown/browser')}
  for(const [name,version] of Object.entries(toolchain))
    assert(evidence.toolchain?.[name]===version,
      'Native runtime toolchain conflicts with package inventory: '+name)
  return toolchain
}

export function inspectNativeRuntime(directory){
  const root=resolve(directory),rootStat=lstatSync(root)
  assert(rootStat.isDirectory()&&!rootStat.isSymbolicLink(),'Native runtime root must be a real directory')
  const files=[]
  function visit(folder,prefix=''){
    for(const name of readdirSync(folder).sort()){
      const path=prefix?prefix+'/'+name:name
      assert(/^[A-Za-z0-9._-]+$/.test(name)&&name!=='.'&&name!=='..','Unsafe native runtime path')
      const absolute=join(folder,name),stat=lstatSync(absolute)
      assert(!stat.isSymbolicLink(),'Native runtime symlink: '+path)
      if(stat.isDirectory())visit(absolute,path)
      else{
        assert(stat.isFile(),'Unsupported native runtime entry: '+path)
        const bytes=readFileSync(absolute)
        files.push({path,bytes:bytes.length,sha256:hash(bytes)})
      }
    }
  }
  visit(root)
  const names=new Set(files.map(file=>file.path))
  for(const path of required)assert(names.has(path),'Missing native runtime asset: '+path)
  const evidence=JSON.parse(readFileSync(join(root,'SHIPPED-INPUTS.json'),'utf8'))
  assert(evidence.format===1&&Array.isArray(evidence.packages)&&evidence.packages.length>0&&
    Array.isArray(evidence.workspaceInputs)&&Array.isArray(evidence.missingNoticeText)&&
    typeof evidence.noticeTextCoverageComplete==='boolean'&&typeof evidence.distributionReviewComplete==='boolean',
  'Invalid native runtime input inventory')
  assert(evidence.noticeTextCoverageComplete===(evidence.missingNoticeText.length===0),
    'Native runtime notice coverage conflicts with missing records')
  if(evidence.ownedOxide){
    assert.equal(evidence.ownedOxide.record,'oxide/BUILD.json','Invalid native Oxide build record path')
    const record=verifyNativeOxideBuild(join(root,'oxide'))
    assert.equal(record.wasm.sha256,evidence.ownedOxide.wasmSHA256,'Native Oxide inventory hash mismatch')
    assert.equal(record.inputs.revision,evidence.ownedOxide.revision,'Native Oxide inventory revision mismatch')
    assert.equal(record.rustInputsSHA256,evidence.ownedOxide.rustInputsSHA256,'Native Oxide dependency inventory mismatch')
  }
  const notices=readFileSync(join(root,'THIRD-PARTY-NOTICES.txt'),'utf8')
  for(const item of evidence.packages){
    assert(typeof item.name==='string'&&typeof item.version==='string'&&typeof item.noticeTextPresent==='boolean',
      'Invalid native runtime package identity')
    assert(notices.includes(`${item.name}@${item.version}\nDeclared license:`),
      'Missing native runtime notice entry: '+item.name+'@'+item.version)
  }
  return {directory:root,entry:'runtime/native/engine.js',engineSHA256:files.find(file=>file.path==='engine.js').sha256,
    ...(Object.hasOwn(evidence,'diagnostics')?{diagnostics:evidence.diagnostics}:{}),
    files,toolchain:nativeRuntimeToolchain(evidence),packageVersions:{'esbuild-wasm':nativeRuntimePackageVersion(evidence,'esbuild-wasm'),
      '@rolldown/browser':nativeRuntimePackageVersion(evidence,'@rolldown/browser')},
    noticeTextCoverageComplete:evidence.noticeTextCoverageComplete,
    distributionReviewComplete:evidence.distributionReviewComplete,
    missingNoticeText:evidence.missingNoticeText}
}

export function copyNativeRuntime(source,destination,{publicationCandidate=false}={}){
  const inspected=inspectNativeRuntime(source)
  if(publicationCandidate)assert(!Object.hasOwn(inspected,'diagnostics'),
    'Diagnostic native runtimes cannot be publication candidates')
  if(publicationCandidate)assert(inspected.noticeTextCoverageComplete&&inspected.distributionReviewComplete,
    'Native runtime distribution review is incomplete')
  const target=resolve(destination)
  assert(!existsSync(target),'Native runtime destination must be new')
  const offset=relative(inspected.directory,target)
  assert(offset==='..'||offset.startsWith('..'+sep),'Native runtime destination must be outside its source')
  mkdirSync(target)
  for(const file of inspected.files){
    const output=join(target,file.path)
    mkdirSync(dirname(output),{recursive:true})
    copyFileSync(join(inspected.directory,file.path),output,constants.COPYFILE_EXCL)
    assert(hash(readFileSync(output))===file.sha256,'Native runtime changed during copy: '+file.path)
  }
  return {...inspected,directory:target}
}

/** Inspect every compiler before copying any files, rejecting ambiguous selection. */
export function inspectNativeRuntimeSet(directories){
  assert(Array.isArray(directories)&&directories.length>0,'Native runtime set must be nonempty')
  const runtimes=directories.map(inspectNativeRuntime)
  const identities=new Set()
  return runtimes.map(runtime=>{
    const {vite,rolldown}=runtime.toolchain
    const id=`vite-${vite}-rolldown-${rolldown}`
    assert(!identities.has(id),'Duplicate native runtime toolchain: '+id)
    identities.add(id)
    return {...runtime,id,entry:`runtime/native/${id}/engine.js`}
  })
}

export function copyNativeRuntimeSet(sources,destination,options={}){
  const runtimes=inspectNativeRuntimeSet(sources)
  if(options.publicationCandidate)
    for(const runtime of runtimes){
      assert(!Object.hasOwn(runtime,'diagnostics'),'Diagnostic native runtimes cannot be publication candidates: '+runtime.id)
      assert(runtime.noticeTextCoverageComplete&&runtime.distributionReviewComplete,
        'Native runtime distribution review is incomplete: '+runtime.id)
    }
  const target=resolve(destination)
  assert(!existsSync(target),'Native runtime destination must be new')
  for(const runtime of runtimes){
    const offset=relative(runtime.directory,target)
    assert(offset==='..'||offset.startsWith('..'+sep),'Native runtime destination must be outside its source')
  }
  mkdirSync(target)
  return runtimes.map(runtime=>({...copyNativeRuntime(runtime.directory,join(target,runtime.id),options),
    id:runtime.id,entry:runtime.entry}))
}
