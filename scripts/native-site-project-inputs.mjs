import assert from 'node:assert/strict'
import {lstatSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {nativeExampleHash,readPinnedNativeExamples} from './native-example-sources.mjs'

export const nativeSiteExampleIds=['start-counter','start-basic','start-streaming-data-from-server-functions','basic-ssr-file-based']

export function verifyNativeSiteProject(project,expected,sdkSHA256){
  for(const [field,value]of Object.entries({sourceRevision:expected.revision,sourceSHA256:expected.sourceSHA256,npmLockSHA256:expected.npmLockSHA256}))
    assert.equal(project[field],value,'Example source identity differs: '+field)
  const text=Object.keys(project.files),binary=Object.keys(project.binaryFiles)
  assert.equal(text.length+binary.length,new Set([...text,...binary]).size,'Example contains duplicate files')
  assert.deepEqual([...text,...binary].sort(),Object.keys(expected.files).sort(),'Example file set differs')
  for(const [path,bytes]of Object.entries(expected.files)){
    const encoded=Object.hasOwn(project.files,path)?project.files[path]:project.binaryFiles[path]
    assert.equal(typeof encoded,'string','Example file contents must be strings')
    const actual=Object.hasOwn(project.files,path)?Buffer.from(encoded):Buffer.from(encoded,'base64')
    if(Object.hasOwn(project.binaryFiles,path))assert.equal(actual.toString('base64'),encoded,'Example base64 differs')
    assert.ok(actual.equals(Buffer.from(bytes)),'Example contents differ: '+path)
  }
  if(sdkSHA256!==undefined)
    assert.equal(project.identity,nativeExampleHash(JSON.stringify([expected.sourceSHA256,expected.npmLockSHA256,sdkSHA256])),
      'Example SDK identity differs')
}

export function nativeSiteProjectInputs(fixture,projectRoot,sdkSHA256){
  const pinned=readPinnedNativeExamples(projectRoot)
  return Object.fromEntries(nativeSiteExampleIds.map(example=>{
    const path=join(fixture,'.native-local',example+'.json'),stat=lstatSync(path)
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Example input must be a regular file')
    const expected=pinned.examples.get('react/'+example)
    assert.ok(expected,'Pinned example is missing')
    const bytes=readFileSync(path)
    verifyNativeSiteProject(JSON.parse(bytes),expected,sdkSHA256)
    return [example,nativeExampleHash(bytes)]
  }))
}
