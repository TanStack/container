import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdirSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {nativeSiteExampleIds,nativeSiteProjectInputs,verifyNativeSiteProject} from '../scripts/native-site-project-inputs.mjs'
import {nativeExampleHash,readPinnedNativeExamples} from '../scripts/native-example-sources.mjs'

const sdkSHA256='a'.repeat(64)
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'native-site-input-test-'))
  mkdirSync(join(directory,'.native-local'))
  const pinned=readPinnedNativeExamples()
  for(const id of nativeSiteExampleIds){
    const expected=pinned.examples.get('react/'+id),files={},binaryFiles={}
    for(const [path,value]of Object.entries(expected.files)){
      const bytes=Buffer.from(value),text=bytes.toString('utf8')
      if(Buffer.from(text).equals(bytes)&&!text.includes('\0'))files[path]=text
      else binaryFiles[path]=bytes.toString('base64')
    }
    writeFileSync(join(directory,'.native-local',id+'.json'),JSON.stringify({files,binaryFiles,
      sourceRevision:expected.revision,sourceSHA256:expected.sourceSHA256,npmLockSHA256:expected.npmLockSHA256,
      identity:nativeExampleHash(JSON.stringify([expected.sourceSHA256,expected.npmLockSHA256,sdkSHA256]))}))
  }
  return directory
}

test('real-site inputs bind all four original project payloads and SDK identities',()=>{
  const directory=fixture(),hashes=nativeSiteProjectInputs(directory,process.cwd(),sdkSHA256)
  assert.deepEqual(Object.keys(hashes),nativeSiteExampleIds)
  for(const value of Object.values(hashes))assert.match(value,/^[0-9a-f]{64}$/)
  assert.throws(()=>nativeSiteProjectInputs(directory,process.cwd(),'b'.repeat(64)),/SDK identity differs/)
})

test('changed Basic or Router bytes fail even when their claimed source hashes stay unchanged',()=>{
  for(const id of ['start-basic','basic-ssr-file-based']){
    const directory=fixture(),path=join(directory,'.native-local',id+'.json')
    const project=JSON.parse(readFileSync(path))
    project.files['/project/src/routes/index.tsx']+='\n'
    writeFileSync(path,JSON.stringify(project))
    assert.throws(()=>nativeSiteProjectInputs(directory,process.cwd(),sdkSHA256),/Example contents differ/)
  }
})

test('symlinked project payload cannot be substituted for a fixture input',()=>{
  const directory=mkdtempSync(join(tmpdir(),'native-site-input-link-test-'))
  mkdirSync(join(directory,'.native-local'))
  const original=fixture()
  symlinkSync(join(original,'.native-local/start-counter.json'),join(directory,'.native-local/start-counter.json'))
  assert.throws(()=>nativeSiteProjectInputs(directory,process.cwd(),sdkSHA256),/regular file/)
})

test('binary corruption and a duplicate text/binary path fail payload validation',()=>{
  const expected={revision:'r',sourceSHA256:'s',npmLockSHA256:'l',files:{'/project/a.bin':new Uint8Array([0,255])}}
  const project={sourceRevision:'r',sourceSHA256:'s',npmLockSHA256:'l',files:{},binaryFiles:{'/project/a.bin':'AP8='}}
  assert.doesNotThrow(()=>verifyNativeSiteProject(project,expected))
  assert.throws(()=>verifyNativeSiteProject({...project,binaryFiles:{'/project/a.bin':'AAA='}},expected),/contents differ/)
  assert.throws(()=>verifyNativeSiteProject({...project,files:{'/project/a.bin':''}},expected),/duplicate files/)
})
