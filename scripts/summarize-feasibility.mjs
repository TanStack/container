import { readFile, writeFile } from 'node:fs/promises'
const report = JSON.parse(
  await readFile(
    new URL('../reports/feasibility-results.json', import.meta.url),
    'utf8',
  ),
)
const matrices = []
async function visit(suite) {
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests ?? [])
      for (const result of test.results ?? [])
        for (const attachment of result.attachments ?? [])
          if (attachment.name === 'compatibility.json') {
            const raw = attachment.body
              ? Buffer.from(attachment.body, 'base64').toString()
              : await readFile(attachment.path, 'utf8')
            matrices.push({ browser: test.projectName, ...JSON.parse(raw) })
          }
  for (const child of suite.suites ?? []) await visit(child)
}
for (const suite of report.suites) await visit(suite)
if (matrices.length !== 3)
  throw new Error(`Expected three browser matrices, got ${matrices.length}`)
const lines = [
  '# Node reference compatibility',
  '',
  `Generated ${new Date().toISOString()}. Node ${matrices[0].node}. Browser test failures: ${report.stats.unexpected}.`,
  '',
  'These are targeted differential probes, not a percentage of Node compatibility. A match means exit code and stdout matched the same trusted fixture on Node. Gaps are not test passes.',
  '',
  '| Browser | Backend | Matched | Gaps |',
  '| --- | --- | ---: | ---: |',
]
for (const matrix of matrices)
  for (const backend of ['native', 'quickjs']) {
    const rows = matrix.results.filter((x) => x.backend === backend)
    lines.push(
      `| ${matrix.browser} | ${backend} | ${rows.filter((x) => x.status === 'match').length} | ${rows.filter((x) => x.status === 'gap').length} |`,
    )
  }
lines.push(
  '',
  '## Cases',
  '',
  '| Probe | ' +
    matrices
      .flatMap((m) => ['native', 'quickjs'].map((b) => m.browser + '/' + b))
      .join(' | ') +
    ' |',
  '| --- | ' + matrices.flatMap(() => ['---', '---']).join(' | ') + ' |',
)
for (const first of matrices[0].results.filter((r) => r.backend === 'native'))
  lines.push(
    `| ${first.id} | ` +
      matrices
        .flatMap((m) =>
          ['native', 'quickjs'].map(
            (b) =>
              m.results.find((r) => r.id === first.id && r.backend === b)
                .status,
          ),
        )
        .join(' | ') +
      ' |',
  )
await writeFile(
  new URL('../reports/compatibility-summary.md', import.meta.url),
  lines.join('\n') + '\n',
)
await writeFile(
  new URL('../reports/compatibility-matrix.json', import.meta.url),
  JSON.stringify(matrices, null, 2) + '\n',
)
console.log(lines.slice(0, 12).join('\n'))
