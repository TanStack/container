import {readFileSync} from 'node:fs'
import {expect,test} from 'vitest'
import nativeSea from 'node:sea'
// @ts-expect-error The guest source intentionally has no host declaration file.
import * as guestSea from '../src/sandbox/guest-sea.js'

const report=JSON.parse(readFileSync('reports/node-runtime-tooling-feasibility.json','utf8'))

test('SEA exposes only the truthful native non-SEA state',()=>{
  expect(guestSea.isSea()).toBe(nativeSea.isSea())
  for(const name of ['getAsset','getRawAsset','getAssetAsBlob'] as const){
    for(const key of [undefined,1,'asset']){
      let nativeCode='',guestCode=''
      try{(nativeSea[name] as any)(key)}catch(error){nativeCode=(error as NodeJS.ErrnoException).code??''}
      try{(guestSea[name] as any)(key)}catch(error){guestCode=(error as NodeJS.ErrnoException).code??''}
      expect(guestCode).toBe(nativeCode)
    }
  }
  expect(()=>guestSea.getAssetKeys()).toThrowError(expect.objectContaining({code:'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION'}))
})

test('inspector and trace decisions stay explicit and missing',()=>{
  expect(report.format).toBe(1)
  expect(report.decisions['node:inspector']).toMatchObject({status:'missing'})
  expect(report.decisions['node:inspector/promises']).toMatchObject({status:'missing'})
  expect(report.decisions['node:trace_events']).toMatchObject({status:'missing'})
  expect(report.decisions['node:sea']).toMatchObject({status:'implemented-non-sea-query-surface'})
  const surface=JSON.parse(readFileSync('reports/node-api-surface.json','utf8'))
  expect(surface.missingPublicModules).toEqual(expect.arrayContaining(['node:inspector','node:inspector/promises','node:trace_events']))
})
