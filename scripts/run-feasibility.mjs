import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
await mkdir(new URL('reports/', root), { recursive: true })
await writeFile(
  new URL('reports/compatibility-summary.md', root),
  '# Feasibility run in progress\n\nNo completed results for this run yet.\n',
)
await writeFile(
  new URL('reports/compatibility-matrix.json', root),
  JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }) +
    '\n',
)
const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: 'inherit',
    })
    child.on('error', (error) => {
      console.error(error)
      resolve(1)
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
const tests = await run([
  'node_modules/@playwright/test/cli.js',
  'test',
  '--config=playwright.feasibility.config.ts',
])
const summary = await run(['scripts/summarize-feasibility.mjs'])
process.exitCode = tests || summary
