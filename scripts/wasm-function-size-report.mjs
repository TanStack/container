import { readFileSync } from 'node:fs'

function unsigned(bytes, cursor) {
  let value = 0
  let shift = 0
  while (true) {
    const byte = bytes[cursor.offset++]
    if (byte === undefined || shift > 35) throw Error('Invalid unsigned LEB128 value')
    value += (byte & 0x7f) * 2 ** shift
    if (!(byte & 0x80)) return value
    shift += 7
  }
}

export function wasmFunctionSizes(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '0061736d01000000') throw Error('Expected a WebAssembly 1 module')
  const cursor = { offset: 8 }
  while (cursor.offset < bytes.length) {
    const id = bytes[cursor.offset++]
    const size = unsigned(bytes, cursor)
    const end = cursor.offset + size
    if (end > bytes.length) throw Error('WebAssembly section exceeds module bytes')
    if (id === 10) {
      const count = unsigned(bytes, cursor)
      const sizes = []
      for (let index = 0; index < count; index++) {
        const bodySize = unsigned(bytes, cursor)
        sizes.push(bodySize)
        cursor.offset += bodySize
        if (cursor.offset > end) throw Error('WebAssembly function body exceeds code section')
      }
      if (cursor.offset !== end) throw Error('WebAssembly code section has trailing bytes')
      return sizes
    }
    cursor.offset = end
  }
  return []
}

export function summarizeWasmFunctionSizes(bytes) {
  const sizes = wasmFunctionSizes(bytes).sort((a, b) => a - b)
  const percentile = value => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * value))] ?? 0
  return {
    moduleBytes: bytes.length,
    functions: sizes.length,
    codeBytes: sizes.reduce((total, value) => total + value, 0),
    medianBodyBytes: percentile(0.5),
    p95BodyBytes: percentile(0.95),
    p99BodyBytes: percentile(0.99),
    maxBodyBytes: sizes.at(-1) ?? 0,
    over100KiB: sizes.filter(value => value > 100 * 1024).length,
    over1MiB: sizes.filter(value => value > 1024 * 1024).length,
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.length < 3) throw Error('Usage: node scripts/wasm-function-size-report.mjs <module.wasm> [...]')
  const report = Object.fromEntries(process.argv.slice(2).map(path => [path, summarizeWasmFunctionSizes(readFileSync(path))]))
  console.log(JSON.stringify(report, null, 2))
}
