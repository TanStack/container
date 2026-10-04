import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {releaseToolchainPlan,releaseToolchainPins,verifyDownload,selectGoDownload} from '../scripts/setup-release-toolchains.mjs'
import {releaseRuntimeBuildPlan,buildReleaseRuntime} from '../scripts/build-release-runtime.mjs'
import {mvdanShellGoBuild,mvdanShellBuildArguments} from '../scripts/mvdan-shell-build-options.mjs'

test('shell builds exclude checkout identity and retain the locked offline recipe',()=>{
  assert.deepEqual(mvdanShellGoBuild,{trimpath:true,buildvcs:false,ldflags:['-s','-w']})
  assert.deepEqual(mvdanShellBuildArguments('/output/shell.wasm'),[
    'build','-trimpath','-buildvcs=false','-mod=readonly','-ldflags=-s -w','-o','/output/shell.wasm','.',
  ])
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
