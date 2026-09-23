import cases from './als-cases.json'
import rawCases from './als-cases.json?raw'
import { Workspace } from '../sandbox/workspace'
import type { ExecutionResult } from '../sandbox/process'

export interface EngineALSResult {
  id: string
  status: 'match' | 'gap'
  expected: string
  actual: ExecutionResult
}
export async function runEngineALS(onResult: (result: EngineALSResult) => void = () => {}, engine: 'quickjs-als' | 'quickjs-als-asyncify' = 'quickjs-als') {
  const response = await fetch('/quickjs-als/reference.json', { cache: 'no-store' })
  if (!response.ok) throw new Error('Run npm run probe:engine-als to generate the reference.')
  const reference = await response.json()
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawCases))),
    x=>x.toString(16).padStart(2,'0')).join('')
  if (reference.corpusSHA256 !== digest || reference.results.length !== cases.length)
    throw new Error('ALS reference is stale. Regenerate it before comparing results.')
  const results: EngineALSResult[] = []
  for (const fixture of cases) {
    const expected = reference.results.find((x: {id:string})=>x.id===fixture.id)?.expected
    if (typeof expected !== 'string') throw new Error('Missing ALS reference: '+fixture.id)
    const w = new Workspace({ files: {
      '/main.mjs': `import {AsyncLocalStorage as ALS} from 'node:async_hooks';
        const result=await (async()=>{${fixture.code}})(); console.log(JSON.stringify(result));`,
    } })
    try {
      const actual = await w.executeInVM('/main.mjs', {engine,maxBytes:16*1024*1024})
      const result: EngineALSResult = {id:fixture.id,expected,actual,
        status:actual.exitCode===0 && actual.stdout.trim()===expected ? 'match':'gap'}
      results.push(result)
      onResult(result)
    } finally { w.close() }
  }
  const build = engine==='quickjs-als' ? reference.build : await (await fetch('/quickjs-als-asyncify/build.json')).json()
  return { generatedAt:new Date().toISOString(), node:reference.node, build, engine,
    userAgent:navigator.userAgent, crossOriginIsolated, hostSharedArrayBuffer:typeof SharedArrayBuffer,
    nativeAwait:true, corpusSHA256:digest, results }
}
