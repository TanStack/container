// Self-contained so the same cases can run in a guest through toString().
export function atomicCases(api, bytes, plainBytes) {
  const results = []
  const record = (name, fn) => {
    try { const value = fn(); results.push([name, typeof value === 'bigint' ? value.toString() : value ?? null]) }
    catch (error) { results.push([name, {error: error.name}]) }
  }
  for (const shared of [true, false]) {
    const memory = new api.Memory({initial: 1, maximum: 2, shared})
    const exports = new api.Instance(new api.Module(shared ? bytes : plainBytes), {env: {memory}}).exports
    const prefix = shared ? 'shared' : 'plain'
    for (const [type, bits] of [['i32',32],['i32',8],['i32',16],['i64',64],['i64',8],['i64',16],['i64',32]]) {
      const tag = type + '_' + bits
      const value = n => type === 'i64' ? BigInt(n) : Number(n)
      const store = n => exports[tag + '_store'](16, value(n))
      const load = () => exports[tag + '_load'](16)
      const run = (op, ...args) => exports[tag + '_' + op](16, ...args.map(value))
      record(prefix + ':' + tag + ':store-load', () => { store(-1); return load() })
      for (const op of ['add','sub','and','or','xor','xchg']) {
        record(prefix + ':' + tag + ':' + op + ':old', () => { store(-1); return run(op, 3) })
        record(prefix + ':' + tag + ':' + op + ':new', load)
      }
      record(prefix + ':' + tag + ':cmpxchg-match-old', () => { store(7); return run('cmpxchg',7,-1) })
      record(prefix + ':' + tag + ':cmpxchg-match-new', load)
      record(prefix + ':' + tag + ':cmpxchg-miss-old', () => run('cmpxchg',7,3))
      record(prefix + ':' + tag + ':cmpxchg-miss-new', load)
      if (bits < Number(type.slice(1))) {
        record(prefix + ':' + tag + ':cmpxchg-truncated-expected', () => { store(7); return run('cmpxchg', (1n << BigInt(bits)) + 7n, 9) })
        record(prefix + ':' + tag + ':cmpxchg-truncated-new', load)
      }
      if (bits > 8) record(prefix + ':' + tag + ':unaligned', () => exports[tag + '_load'](1))
      record(prefix + ':' + tag + ':bounds', () => exports[tag + '_load'](65536))
      record(prefix + ':' + tag + ':last-element', () => exports[tag + '_load'](65536 - bits / 8))
    }
    exports.i32_32_store(0, 42)
    exports.i64_64_store(8, 42n)
    record(prefix + ':wait32-mismatch', () => exports.wait32(0, 41, 0n))
    record(prefix + ':wait32-zero', () => exports.wait32(0, 42, 0n))
    record(prefix + ':wait64-mismatch', () => exports.wait64(8, 41n, 0n))
    record(prefix + ':wait64-zero', () => exports.wait64(8, 42n, 0n))
    record(prefix + ':wait32-alignment', () => exports.wait32(1, 42, 0n))
    record(prefix + ':wait64-bounds', () => exports.wait64(65536, 42n, 0n))
    for (const count of [0, 1, 2147483648, 4294967295]) record(prefix + ':notify-' + count, () => exports.notify(0, count))
    record(prefix + ':notify-alignment', () => exports.notify(1, 1))
    record(prefix + ':notify-bounds', () => exports.notify(65536, 1))
    record(prefix + ':fence', () => exports.fence())
  }
  return results
}
