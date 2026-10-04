import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import test from 'node:test'
import {prepareNativeStreamingNodeControl,runNativeStreamingNodeControl} from '../scripts/control-native-streaming-build.mjs'
import {readPinnedNativeExamples} from '../scripts/native-example-sources.mjs'

test('Node control uses the same pinned source, manifest and lock as browser acceptance',()=>{
  const pinned=readPinnedNativeExamples(),input=pinned.examples.get('react/start-streaming-data-from-server-functions')
  const prepared=prepareNativeStreamingNodeControl()
  assert.equal(prepared.sourceRevision,pinned.manifest.revision)
  assert.equal(prepared.examplesManifestSHA256,pinned.manifestSHA256)
  assert.equal(prepared.sourceSHA256,input.sourceSHA256)
  assert.equal(prepared.lockSHA256,input.npmLockSHA256)
  for(const [path,bytes]of Object.entries(input.files))
    assert.deepEqual(readFileSync(join(prepared.destination,path.slice('/project/'.length))),Buffer.from(bytes))
})

test('failed install is retained and cannot continue into a build',()=>{
  const calls=[]
  const result=runNativeStreamingNodeControl({run:(command,args)=>{
    calls.push({command,args})
    return {status:7,stdout:'',stderr:'',signal:null}
  }})
  assert.deepEqual(calls,[{command:'npm',args:['ci','--ignore-scripts','--no-audit','--no-fund']}])
  assert.equal(result.passed,false)
  assert.equal(result.phase,'install')
  assert.equal(result.install.exitCode,7)
  assert.deepEqual(JSON.parse(readFileSync(join(result.destination,'control-result.json'))),result)
})

test('successful control preserves original commands and records separate install and build results',()=>{
  const calls=[]
  const result=runNativeStreamingNodeControl({run:(command,args)=>{
    calls.push({command,args})
    return {status:0,stdout:'',stderr:'',signal:null}
  }})
  assert.deepEqual(calls,[{command:'npm',args:['ci','--ignore-scripts','--no-audit','--no-fund']},
    {command:'npm',args:['run','build']}])
  assert.equal(result.passed,true)
  assert.equal(result.phase,'complete')
  assert.equal(result.build.exitCode,0)
})

test('changing the manifest or lock fails instead of comparing different inputs',()=>{
  for(const name of ['package.json','package-lock.json']){
    let calls=0,destination
    assert.throws(()=>runNativeStreamingNodeControl({run:(command,args,options)=>{
      calls++;destination=options.cwd
      writeFileSync(join(destination,name),readFileSync(join(destination,name))+'\n')
      return {status:0,stdout:'',stderr:'',signal:null}
    }}),/Control install changed the original/)
    assert.equal(calls,1)
    const result=JSON.parse(readFileSync(join(destination,'control-result.json')))
    assert.equal(result.passed,false)
    assert.match(result.error,/Control install changed the original/)
  }
})

test('failed build and failed process startup cannot become a passing control',()=>{
  const build=runNativeStreamingNodeControl({run:(command,args)=>({status:args[0]==='ci'?0:3,
    stdout:'',stderr:'',signal:null})})
  assert.equal(build.phase,'build')
  assert.equal(build.build.exitCode,3)
  assert.equal(build.passed,false)
  let calls=0
  const install=runNativeStreamingNodeControl({run:()=>{
    calls++
    return {status:null,signal:null,error:Error('npm could not start')}
  }})
  assert.equal(calls,1)
  assert.equal(install.passed,false)
  assert.match(install.install.error,/npm could not start/)
})
