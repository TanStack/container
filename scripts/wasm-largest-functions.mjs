import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { wasmFunctionSizes } from './wasm-function-size-report.mjs'

const wasmOpt = resolve('.toolchains/emsdk/upstream/bin/wasm-opt')
const largestLimit = Number(process.env.WASM_LARGEST_LIMIT ?? 40)
if (!Number.isInteger(largestLimit) || largestLimit < 1 || largestLimit > 100) throw Error('WASM_LARGEST_LIMIT must be from 1 through 100')

function functionNames(path) {
  const output = execFileSync(wasmOpt, [path, '--print-function-map', '--all-features'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return new Map(output.trim().split('\n').map(line => {
    const separator = line.indexOf(':')
    if (separator < 1) throw Error(`Unexpected function map line: ${line}`)
    return [Number(line.slice(0, separator)), line.slice(separator + 1)]
  }))
}

function functionCalls(path) {
  const output = execFileSync(wasmOpt, [path, '--print-call-graph', '--all-features'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const calls = new Map()
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*"([^"]+)" -> "([^"]+)"/)
    if (!match) continue
    if (!calls.has(match[1])) calls.set(match[1], new Set())
    calls.get(match[1]).add(match[2])
  }
  return calls
}

function report(path) {
  const bytes = readFileSync(path)
  const bodySizes = wasmFunctionSizes(bytes)
  const names = functionNames(path)
  const calls = functionCalls(path)
  const importedFunctions = names.size - bodySizes.length
  if (importedFunctions < 0) throw Error('Function map is smaller than the code section')
  const largest = bodySizes.map((bodyBytes, bodyIndex) => {
    const functionIndex = importedFunctions + bodyIndex
    const name = names.get(functionIndex) ?? null
    return { functionIndex, name, bodyBytes, directCalls: name ? [...(calls.get(name) ?? [])].sort() : [] }
  }).sort((left, right) => right.bodyBytes - left.bodyBytes).slice(0, largestLimit)
  return { path, moduleBytes: bytes.length, importedFunctions, definedFunctions: bodySizes.length, largest }
}

if (process.argv.length < 3) throw Error('Usage: node scripts/wasm-largest-functions.mjs <module.wasm> [...]')
console.log(JSON.stringify(process.argv.slice(2).map(path => report(resolve(path))), null, 2))
