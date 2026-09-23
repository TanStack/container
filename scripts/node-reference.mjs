// Executes ONLY the checked-in trusted probe corpus, never submitted guest code.
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const run = promisify(execFile)
const source = new URL('../src/feasibility/cases.json', import.meta.url)
const raw = await readFile(source, 'utf8')
const cases = JSON.parse(raw)
const directory = await mkdtemp(join(tmpdir(), 'sandbox-node-reference-'))
const results = []
for (const probe of cases) {
  if (!/^[a-z0-9-]+$/.test(probe.id)) throw new Error('Invalid probe id')
  const cwd = join(directory, probe.id)
  for (const [path, text] of Object.entries({
    ...probe.files,
    'main.mjs': probe.code,
  })) {
    if (
      path.startsWith('/') ||
      path.split('/').some((x) => x === '..') ||
      path.includes('\\')
    )
      throw new Error('Invalid fixture path')
    const target = join(cwd, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text)
  }
  let result
  try {
    const output = await run(process.execPath, ['main.mjs', 'arg'], {
      cwd,
      env: { PROBE_VALUE: 'scoped' },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    })
    result = { exitCode: 0, stdout: output.stdout, stderr: output.stderr }
  } catch (error) {
    if (typeof error.code !== 'number' || error.killed) throw error
    result = {
      exitCode: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    }
  }
  // Nonzero exit is deliberate only in the exitCode case. Broken fixtures fail the baseline build.
  if (result.exitCode !== (probe.id === 'process-exit-code' ? 7 : 0))
    throw new Error(`${probe.id}: ${result.stderr}`)
  results.push({ id: probe.id, ...result })
}
const destination = new URL(
  '../public/feasibility/node-reference.json',
  import.meta.url,
)
await mkdir(new URL('.', destination), { recursive: true })
await writeFile(
  destination,
  JSON.stringify(
    {
      schema: 1,
      node: process.version,
      platform: process.platform,
      generatedAt: new Date().toISOString(),
      corpusSHA256: createHash('sha256').update(raw).digest('hex'),
      results,
    },
    null,
    2,
  ) + '\n',
)
console.log(
  `Node ${process.version}: ${results.length} reference probes, ${destination.pathname}`,
)
