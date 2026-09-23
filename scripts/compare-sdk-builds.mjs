import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {verifySDK} from './verify-sdk.mjs'

export function compareSDKBuilds(leftDirectory,rightDirectory){
  const left=resolve(leftDirectory),right=resolve(rightDirectory)
  const leftResult=verifySDK(left),rightResult=verifySDK(right)
  assert.deepStrictEqual(rightResult,leftResult,'SDK build summaries differ')
  const leftManifest=JSON.parse(readFileSync(left+'/manifest.json','utf8'))
  const rightManifest=JSON.parse(readFileSync(right+'/manifest.json','utf8'))
  assert.deepStrictEqual(rightManifest,leftManifest,'SDK manifests differ')
  for(const path of Object.values(leftManifest.attestations??{}))assert.deepStrictEqual(readFileSync(right+'/'+path),readFileSync(left+'/'+path),'SDK release attestation differs: '+path)
  return leftResult
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  assert.equal(process.argv.length,4,'Usage: node scripts/compare-sdk-builds.mjs LEFT_SDK RIGHT_SDK')
  console.log(JSON.stringify(compareSDKBuilds(process.argv[2],process.argv[3]),null,2))
}
