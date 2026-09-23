#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  comparisonSummary,
  inspectSources,
  loadContract,
  validateContract,
  validateRunReport,
  validateSourceInspection,
} from '../integrations/tanstack-four-examples/harness.mjs'

const [command, ...args] = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const contract = validateContract(loadContract())

if (command === 'sources') {
  const repository = resolve(option('--repository') ?? '../router')
  const inspection = inspectSources(repository, contract)
  if (args.includes('--verify')) validateSourceInspection(inspection, contract)
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
} else if (command === 'verify') {
  if (!args.length) throw new Error('Usage: verify REPORT...')
  for (const path of args) validateRunReport(JSON.parse(readFileSync(resolve(path), 'utf8')), contract)
  process.stdout.write(`Verified ${args.length} report${args.length === 1 ? '' : 's'}.\n`)
} else if (command === 'summary') {
  const output = option('--out')
  const paths = args.filter((value, index) => value !== '--out' && args[index - 1] !== '--out')
  const reports = paths.map((path) => validateRunReport(JSON.parse(readFileSync(resolve(path), 'utf8')), contract))
  const summary = `${JSON.stringify(comparisonSummary(reports, contract), null, 2)}\n`
  if (output) writeFileSync(resolve(output), summary)
  else process.stdout.write(summary)
} else {
  throw new Error('Usage: tanstack-four-example-contract.mjs sources|verify|summary')
}
