import cases from './cases.json'
import rawCases from './cases.json?raw'
import { Workspace } from '../sandbox/workspace'
import type { ExecutionResult } from '../sandbox/process'
export const compatibilityCaseCount = cases.length * 2

export interface ProbeResult {
  id: string
  area: string
  backend: 'native' | 'quickjs'
  status: 'match' | 'gap'
  expected: { exitCode: number; stdout: string }
  actual: ExecutionResult
}
export async function runCompatibility(
  onResult: (result: ProbeResult) => void = () => {},
) {
  const response = await fetch('/feasibility/node-reference.json', {
    cache: 'no-store',
  })
  if (!response.ok)
    throw new Error('Node reference missing. Run npm run probe:reference.')
  const reference = await response.json()
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawCases)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
  if (
    reference.schema !== 1 ||
    reference.corpusSHA256 !== digest ||
    reference.results.length !== cases.length
  )
    throw new Error(
      'Node reference is stale or invalid. Regenerate it before comparing results.',
    )
  const results: ProbeResult[] = []
  const started = performance.now()
  for (const probe of cases) {
    const expected = reference.results.find(
      (r: { id: string }) => r.id === probe.id,
    )
    if (!expected) throw new Error(`Missing reference for ${probe.id}`)
    for (const backend of ['native', 'quickjs'] as const) {
      const workspace = new Workspace({
        files: Object.fromEntries(
          Object.entries({ ...probe.files, 'main.mjs': probe.code }).map(
            ([path, code]) => ['/' + path, code!],
          ),
        ),
      })
      try {
        const options = {
          env: { PROBE_VALUE: 'scoped' },
          argv: ['arg'],
          timeoutMs: 2000,
        }
        const actual = await (backend === 'native'
          ? workspace.execute('/main.mjs', options)
          : workspace.executeInVM('/main.mjs', options))
        const result: ProbeResult = {
          id: probe.id,
          area: probe.area,
          backend,
          status:
            actual.exitCode === expected.exitCode &&
            actual.stdout === expected.stdout
              ? 'match'
              : 'gap',
          expected: { exitCode: expected.exitCode, stdout: expected.stdout },
          actual,
        }
        results.push(result)
        onResult(result)
      } finally {
        workspace.close()
      }
    }
  }
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    secureContext: isSecureContext,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    node: reference.node,
    corpusSHA256: digest,
    durationMs: performance.now() - started,
    results,
  }
}
