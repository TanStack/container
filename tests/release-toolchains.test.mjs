import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {releaseToolchainPlan,releaseToolchainPins,verifyDownload,selectGoDownload} from '../scripts/setup-release-toolchains.mjs'
import {releaseRuntimeBuildPlan,buildReleaseRuntime} from '../scripts/build-release-runtime.mjs'
import {mvdanShellGoBuild,mvdanShellBuildArguments,mvdanShellModule,mvdanShellModuleLicense} from '../scripts/mvdan-shell-build-options.mjs'

test('shell builds exclude checkout identity and retain the locked offline recipe',()=>{
  assert.deepEqual(mvdanShellGoBuild,{trimpath:true,buildvcs:false,ldflags:['-s','-w']})
  assert.deepEqual(mvdanShellBuildArguments('/output/shell.wasm'),[
    'build','-trimpath','-buildvcs=false','-mod=readonly','-ldflags=-s -w','-o','/output/shell.wasm','.',
  ])
})

function moduleFixture(){
  const directory=mkdtempSync(join(tmpdir(),'mvdan-module-notice-'))
  return {directory,info:{Path:mvdanShellModule.path,Version:mvdanShellModule.version,Dir:directory}}
}

test('shell notice follows the Go-resolved module cache with the same build environment',()=>{
  const {directory,info}=moduleFixture(),license=join(directory,'LICENSE')
  writeFileSync(license,'Notice fixture\n',{flag:'wx'})
  const env={GOOS:'js',GOARCH:'wasm',GOPATH:'/toolchain/gopath',GOMODCACHE:directory,GOPROXY:'off'},calls=[]
  const actual=mvdanShellModuleLicense('/toolchain/go/bin/go','/source',env,(command,args,options)=>{
    calls.push({command,args,options})
    return args[0]==='list'?JSON.stringify(info):'all modules verified\n'
  })
  assert.equal(actual,license)
  assert.deepEqual(calls.map(call=>call.args),[
    ['list','-m','-mod=readonly','-json','mvdan.cc/sh/v3'],['mod','verify'],
  ])
  for(const call of calls){
    assert.equal(call.command,'/toolchain/go/bin/go');assert.equal(call.options.cwd,'/source')
    assert.equal(call.options.env,env);assert.equal(call.options.encoding,'utf8')
  }
  assert.match(readFileSync('scripts/build-mvdan-shell.mjs','utf8'),/copyFileSync\(moduleLicense,mvdanLicense\)/)
})

test('shell notice rejects another module, version, replacement or nonabsolute cache directory',()=>{
  const {info}=moduleFixture()
  for(const change of [{Path:'other/module'},{Version:'v3.14.0'},{Replace:{Dir:'/other'}},{Dir:'relative'},{Dir:null}]){
    let calls=0
    assert.throws(()=>mvdanShellModuleLicense('/go','/source',{},()=>{
      calls++;return JSON.stringify({...info,...change})
    }))
    assert.equal(calls,1,'Invalid module inputs must fail before verification or notice access')
  }
})

test('shell notice rejects missing text, directories and symbolic links',()=>{
  for(const type of ['missing','directory','link']){
    const {directory,info}=moduleFixture(),license=join(directory,'LICENSE')
    if(type==='directory')mkdirSync(license)
    if(type==='link'){
      const target=join(directory,'text');writeFileSync(target,'Notice fixture\n',{flag:'wx'});symlinkSync(target,license)
    }
    assert.throws(()=>mvdanShellModuleLicense('/go','/source',{},(_command,args)=>
      args[0]==='list'?JSON.stringify(info):'all modules verified\n'))
  }
})

test('shell notice preserves Go list and cache-verification failures',()=>{
  const {info}=moduleFixture(),failure=Error('Go module verification failed')
  for(const failed of ['list','mod'])assert.throws(()=>mvdanShellModuleLicense('/go','/source',{},(_command,args)=>{
    if(args[0]===failed)throw failure
    return JSON.stringify(info)
  }),error=>error===failure)
})

test('toolchain plan matches pinned descriptors on Linux x64 and ARM64, and fails on other hosts',()=>{
  const plan=releaseToolchainPlan(process.cwd(),'linux','x64')
  assert.equal(plan.clones.length,0)
  assert.equal(plan.sources.length,0)
  for(const source of plan.sources){
    const descriptor=JSON.parse(readFileSync(`build-inputs/${source.name}-source.json`,'utf8'))
    assert.equal(source.sha256,descriptor.archive.sha256)
    assert.equal(source.url,descriptor.archive.url)
  }
  assert.throws(()=>releaseToolchainPlan(process.cwd(),'darwin','arm64'),/requires Linux/)
  assert.equal(plan.goFilename,`go${releaseToolchainPins.go}.linux-amd64.tar.gz`)
  assert.equal(releaseToolchainPlan(process.cwd(),'linux','arm64').goFilename,`go${releaseToolchainPins.go}.linux-arm64.tar.gz`)
  for(const arch of ['ia32','arm','riscv64','amd64',''])
    assert.throws(()=>releaseToolchainPlan(process.cwd(),'linux',arch),/requires Linux x64 or ARM64/)
})

test('download checksum and official Go release selection fail closed',()=>{
  const bytes=Buffer.from('archive'),sha256=createHash('sha256').update(bytes).digest('hex')
  verifyDownload(bytes,sha256)
  assert.throws(()=>verifyDownload(Buffer.from('changed'),sha256),/checksum mismatch/)
  for(const arch of ['amd64','arm64']){
    const filename=`go${releaseToolchainPins.go}.linux-${arch}.tar.gz`
    const archive={filename,os:'linux',arch,kind:'archive',sha256}
    assert.equal(selectGoDownload([{version:`go${releaseToolchainPins.go}`,files:[archive]}],filename),archive)
    assert.throws(()=>selectGoDownload([],filename),/does not contain/)
    for(const change of [{arch:arch==='amd64'?'arm64':'amd64'},{os:'darwin'},{kind:'installer'}])
      assert.throws(()=>selectGoDownload([{version:`go${releaseToolchainPins.go}`,files:[{...archive,...change}]}],filename),/does not contain/)
    assert.throws(()=>selectGoDownload([{version:'go0.0.0',files:[archive]}],filename),/does not contain/)
  }
  for(const filename of ['go0.0.0.linux-arm64.tar.gz',`go${releaseToolchainPins.go}.linux-riscv64.tar.gz`,''])
    assert.throws(()=>selectGoDownload([],filename),/Use the pinned/)
})

test('native runtime plan builds only shell support and the native catalog, sequentially',()=>{
  const plan=releaseRuntimeBuildPlan()
  const engineCommands=plan.filter(args=>args[0]==='scripts/build-quickjs-als.mjs')
  assert.equal(engineCommands.length,0)
  assert.equal(plan.length,2)
  assert.equal(plan[0][0],'scripts/build-mvdan-shell.mjs')
  const instructions=readFileSync('BUILDING.md','utf8')
  for(const command of engineCommands)assert.ok(instructions.includes(`node ${command.join(' ')}`))
  assert.deepEqual(plan.at(-1),['scripts/build-native-runtime-catalog.mjs'])
  assert.ok(instructions.includes('node scripts/build-native-runtime-catalog.mjs'))
  const calls=[]
  buildReleaseRuntime({run:(command,args)=>calls.push({command,args})})
  assert.deepEqual(calls.map(call=>call.args),plan)
  assert.ok(calls.every(call=>call.command===process.execPath))
  let count=0
  assert.throws(()=>buildReleaseRuntime({run:()=>{if(++count===2)throw Error('build failure')}}),/build failure/)
  assert.equal(count,2)
})
