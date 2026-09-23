import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

const here = new URL('.', import.meta.url)
export const contractPath = new URL('./contract.json', here)

export function loadContract(path = contractPath) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function excluded(path, patterns) {
  const normalized = path.split(sep).join('/')
  return patterns.some(
    (pattern) => normalized === pattern || normalized.startsWith(`${pattern}/`),
  )
}

export function sourceTree(root, patterns = []) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      if (excluded(path, patterns)) continue
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push({ path, absolute })
      else throw new Error(`Unsupported source entry: ${absolute}`)
    }
  }
  visit(root)
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  const hash = createHash('sha256')
  const entries = files.map(({ path, absolute }) => {
    const bytes = readFileSync(absolute)
    const pathBytes = Buffer.from(path)
    const lengths = Buffer.allocUnsafe(8)
    lengths.writeUInt32BE(pathBytes.byteLength, 0)
    lengths.writeUInt32BE(bytes.byteLength, 4)
    hash.update(lengths).update(pathBytes).update(bytes)
    return { path, bytes: bytes.byteLength, sha256: sha256(bytes) }
  })
  return { sha256: hash.digest('hex'), files: entries.length, entries }
}

export function inspectSources(repositoryRoot, contract = loadContract()) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  const dirty = execFileSync(
    'git',
    [
      'status',
      '--porcelain',
      '--',
      ...contract.examples.map((example) =>
        `${contract.source.root}/${example.sourcePath}`,
      ),
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  const examples = Object.fromEntries(
    contract.examples.map((example) => {
      const root = resolve(
        repositoryRoot,
        contract.source.root,
        example.sourcePath,
      )
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        throw new Error(`Missing source directory: ${root}`)
      }
      return [example.id, sourceTree(root, contract.source.excludedPaths)]
    }),
  )
  return {
    repository: contract.source.repository,
    revision,
    dirty,
    examples,
  }
}

export function validateContract(contract = loadContract()) {
  const failures = []
  if (contract.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (new Set(contract.examples.map((item) => item.id)).size !== 4) {
    failures.push('contract must name four unique examples')
  }
  for (const example of contract.examples) {
    if (!/^[a-f0-9]{64}$/.test(example.sourceTreeSHA256)) {
      failures.push(`${example.id} does not have a bound source tree hash`)
    }
    for (const name of ['install', 'start']) {
      if (!Array.isArray(example.commands?.[name]) || !example.commands[name].length) {
        failures.push(`${example.id} is missing its ${name} command`)
      }
    }
    for (const required of ['ssr', 'hydration', 'live-edit']) {
      if (!example.assertions.some((assertion) => assertion.id === required)) {
        failures.push(`${example.id} is missing the ${required} assertion`)
      }
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  return contract
}

export function validateSourceInspection(inspection, contract = loadContract()) {
  const failures = []
  if (inspection.revision !== contract.source.revision) {
    failures.push(
      `source revision is ${inspection.revision}, expected ${contract.source.revision}`,
    )
  }
  if (inspection.dirty.length) {
    failures.push(`source examples are dirty: ${inspection.dirty.join(', ')}`)
  }
  for (const example of contract.examples) {
    const actual = inspection.examples[example.id]
    if (actual?.sha256 !== example.sourceTreeSHA256) {
      failures.push(
        `${example.id} source tree is ${actual?.sha256 ?? 'missing'}, expected ${example.sourceTreeSHA256}`,
      )
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  return inspection
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function validateRunReport(report, contract = loadContract()) {
  validateContract(contract)
  const failures = []
  const example = contract.examples.find((item) => item.id === report.exampleId)
  const runtime = contract.runtimes[report.runtime]
  if (report.schemaVersion !== 1) failures.push('report schemaVersion must be 1')
  if (report.suiteId !== contract.suiteId) failures.push('report suiteId does not match')
  if (!example) failures.push(`unknown exampleId: ${report.exampleId}`)
  if (!runtime) failures.push(`unknown runtime: ${report.runtime}`)
  if (!contract.resultStates.includes(report.result)) failures.push(`invalid result: ${report.result}`)
  if (!nonEmptyString(report.browser?.name) || !nonEmptyString(report.browser?.version)) {
    failures.push('browser name and version are required')
  }
  if (!nonEmptyString(report.startedAt) || !nonEmptyString(report.finishedAt)) {
    failures.push('startedAt and finishedAt are required')
  }
  if (
    !nonEmptyString(report.integration?.repository) ||
    !nonEmptyString(report.integration?.revision) ||
    !Array.isArray(report.integration?.files) ||
    report.integration.files.length === 0
  ) {
    failures.push('integration repository, revision, and hashed files are required')
  } else {
    for (const [index, file] of report.integration.files.entries()) {
      if (!nonEmptyString(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        failures.push(`integration.files[${index}] requires path and SHA256`)
      }
    }
  }
  if (example) {
    if (report.source?.revision !== contract.source.revision) failures.push('source revision does not match')
    if (report.source?.treeSHA256 !== example.sourceTreeSHA256) failures.push('source tree hash does not match')
    if (JSON.stringify(report.commands) !== JSON.stringify(example.commands)) failures.push('commands do not match the contract')
    if (JSON.stringify(report.observedCommands) !== JSON.stringify(example.commands)) failures.push('observed commands do not match the contract')
  }
  if (runtime) {
    for (const field of runtime.requiredArtifactFields) {
      if (!nonEmptyString(report.artifact?.[field])) failures.push(`artifact.${field} is required`)
    }
  }
  if (report.runtime === 'sdk' && report.artifact?.packaging === 'split') {
    for (const field of ['manifestSHA256', 'tarballSHA256', 'runtimeManifestSHA256', 'runtimeTarballSHA256', 'deploymentManifestSHA256']) {
      if (!/^[a-f0-9]{64}$/.test(report.artifact[field] ?? '')) failures.push(`artifact.${field} must be SHA256`)
    }
    if (report.artifact.runtimePackage !== '@tanstack/browser-sandbox-runtime-experimental') failures.push('artifact.runtimePackage must identify the runtime package')
    for (const [observed, declared] of [['sdkManifestSHA256', 'manifestSHA256'], ['runtimeManifestSHA256', 'runtimeManifestSHA256'], ['deploymentManifestSHA256', 'deploymentManifestSHA256']]) {
      if (report.observedAssetIdentity?.[observed] !== report.artifact[declared]) failures.push(`observedAssetIdentity.${observed} does not match the artifact`)
    }
  }
  if (!Array.isArray(report.adaptations)) failures.push('adaptations must be an array')
  else {
    for (const [index, adaptation] of report.adaptations.entries()) {
      if (!nonEmptyString(adaptation.id) || !nonEmptyString(adaptation.description)) {
        failures.push(`adaptations[${index}] requires id and description`)
      }
      if (!Array.isArray(adaptation.files)) failures.push(`adaptations[${index}].files must be an array`)
      if (!Array.isArray(adaptation.packages)) failures.push(`adaptations[${index}].packages must be an array`)
      if (!adaptation.files?.length && !adaptation.packages?.length) {
        failures.push(`adaptations[${index}] must bind at least one file or package change`)
      }
      for (const [fileIndex, file] of (adaptation.files ?? []).entries()) {
        if (
          !nonEmptyString(file.path) ||
          (file.beforeSHA256 !== null && !/^[a-f0-9]{64}$/.test(file.beforeSHA256)) ||
          !/^[a-f0-9]{64}$/.test(file.afterSHA256)
        ) {
          failures.push(`adaptations[${index}].files[${fileIndex}] is not hash-bound`)
        }
      }
      for (const [packageIndex, item] of (adaptation.packages ?? []).entries()) {
        if (!nonEmptyString(item.name) || !nonEmptyString(item.version)) {
          failures.push(`adaptations[${index}].packages[${packageIndex}] requires name and version`)
        }
      }
    }
  }
  if (report.result === 'passed' && example) {
    const results = new Map((report.assertions ?? []).map((item) => [item.id, item]))
    for (const assertion of example.assertions) {
      if (results.get(assertion.id)?.result !== 'passed') {
        failures.push(`passed report lacks passing assertion: ${assertion.id}`)
      }
    }
    if (report.diagnostics?.pageErrors?.length || report.diagnostics?.consoleErrors?.length) {
      failures.push('passed report contains browser errors')
    }
  }
  if (report.result === 'unsupported' && !nonEmptyString(report.limitation)) {
    failures.push('unsupported report requires a limitation')
  }
  if (report.result === 'failed' && !nonEmptyString(report.error)) {
    failures.push('failed report requires an error')
  }
  if (failures.length) throw new Error(failures.join('\n'))
  return report
}

export function comparisonSummary(reports, contract = loadContract()) {
  const cell = (runtime, exampleId) => {
    const runs = reports
      .filter((report) => report.runtime === runtime && report.exampleId === exampleId)
      .map((report) => ({
        result: report.result,
        browser: report.browser,
        artifact: report.artifact,
        startedAt: report.startedAt,
        ...(report.error ? { error: report.error } : {}),
        ...(report.limitation ? { limitation: report.limitation } : {}),
      }))
    const status =
      runs.length === 0
        ? 'not-run'
        : runs.some((run) => run.result === 'failed')
          ? 'failed'
          : runs.every((run) => run.result === 'passed')
            ? 'passed'
            : runs.some((run) => run.result === 'unsupported')
              ? 'unsupported'
              : 'not-run'
    return { status, runs }
  }
  return {
    schemaVersion: 1,
    suiteId: contract.suiteId,
    source: contract.source,
    generatedAt: new Date().toISOString(),
    rows: contract.examples.map((example) => ({
      exampleId: example.id,
      sdk: cell('sdk', example.id),
      webcontainer: cell('webcontainer', example.id),
    })),
  }
}
