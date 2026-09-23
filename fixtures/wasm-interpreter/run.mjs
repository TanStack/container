// Shared Node/browser assertions against a standalone interpreter, not the guest JS API.
export async function runProbe(engine, load, progress = () => {}) {
  const results = []
  const equal = (actual, expected) => {
    if (actual !== expected) throw Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
  const check = async (name, fn) => {
    const start = performance.now()
    try { const detail = await fn(); results.push({name, passed: true, ms: performance.now() - start, detail}) }
    catch (error) { results.push({name, passed: false, ms: performance.now() - start, error: String(error) + '\n' + (error.stack || '')}) }
    finally { engine._probe_close(); progress(results.at(-1)) }
  }
  const error = () => engine.UTF8ToString(engine._probe_error())
  const open = (bytes, gas = 10_000_000, imports = 0) => {
    const ptr = engine._malloc(bytes.length || 1)
    if (!ptr) throw Error('Input allocation failed')
    try {
      engine.HEAPU8.set(bytes, ptr)
      if (engine._probe_open(ptr, bytes.length, gas, imports)) throw Error(error())
    } finally { engine._free(ptr) }
  }
  const call = (name, ...args) => {
    const failed = engine.ccall('probe_call', 'number', ['string', 'number', 'number'], [name, args.length, args[0] || 0])
    equal(engine._probe_frames(), 0)
    if (failed) throw Error(error())
    return engine._probe_answer()
  }
  const memory = () => new Uint8Array(engine.HEAPU8.buffer, engine._probe_memory(), engine._probe_memory_size())
  const trap = (fn, pattern) => {
    try { fn() } catch (failure) {
      if (!pattern.test(String(failure))) throw failure
      return String(failure)
    }
    throw Error('Expected rejection')
  }
  const controls = await load('controls.wasm')
  const native = new WebAssembly.Instance(new WebAssembly.Module(controls)).exports
  const recover = () => { engine._probe_budget(10_000_000); equal(call('answer'), 42) }
  await check('i32 exports and mutable global match native', () => {
    open(controls); equal(call('answer'), native.answer())
    for (let i = 0; i < 10; i++) equal(call('bump'), native.bump())
  })
  await check('bulk memory and zero initialization match native', () => {
    open(controls); equal(call('read', 10), native.read(10))
    call('fill', 100); native.fill(100)
    for (let i = 0; i < 101; i++) equal(call('read', i), native.read(i))
  })
  await check('memory growth preserves contents and reports actual allocation', () => {
    open(controls); call('fill', 10)
    equal(call('grow', 1), 1); equal(call('size'), 2); equal(memory().length, 2 * 65536)
    equal(call('read', 0), 7); equal(call('read', 65536), 0)
    equal(call('grow', 126), 2); equal(memory().length, 128 * 65536)
    equal(call('grow', 1), -1); equal(call('size'), 128); equal(memory().length, 128 * 65536)
    equal(call('grow', -1), -1); recover()
  })
  for (const [name, pattern] of [['loop', /gas/i], ['recurse', /stack/i], ['indirect', /stack/i], ['loopTail', /stack/i], ['oob', /bounds/i], ['unreachable', /unreachable/i]]) {
    await check(`${name} traps and same instance recovers`, () => {
      open(controls, name === 'loop' ? 1000 : 10_000_000)
      const message = trap(() => call(name), pattern)
      const gasUsed = engine._probe_used(); recover()
      return {message, gasUsed}
    })
  }
  await check('bounded recursion and tail calls match native', () => {
    open(controls); equal(call('depth', 100), native.depth(100)); equal(call('tail', 10000), native.tail(10000))
    trap(() => call('depth', 300), /stack/i); equal(call('depth', 100), 100); recover()
  })
  const startLoop = await load('start-loop.wasm')
  await check('start function is metered before instantiation', () => {
    const message = trap(() => open(startLoop, 1000), /gas/i)
    open(controls); recover(); return {message}
  })
  const imported = await load('imports.wasm')
  await check('unlinked host import is rejected', () => {
    const message = trap(() => { open(imported); call('answer') }, /import|link|function/i)
    open(controls); recover(); return {message}
  })
  await check('explicit host import executes', () => {
    open(imported, 10_000_000, 1); equal(call('answer'), 42)
  })
  const oversized = await load('oversized.wasm')
  await check('initial memory above 8 MiB is rejected', () => {
    const message = trap(() => open(oversized), /memory|pages|limit/i)
    open(controls); recover(); return {message}
  })
  const aggregate = await load('aggregate.wasm')
  await check('aggregate allocation cannot exceed 64 MiB interpreter heap', () => {
    const message = trap(() => open(aggregate), /memory|alloc/i)
    open(controls); recover(); return {message, heapBytes: engine.HEAPU8.buffer.byteLength}
  })
  for (const length of [0, 1, 7, 9, controls.length - 1]) {
    await check(`truncated module ${length} rejects and recovers`, () => {
      const bytes = controls.slice(0, length)
      equal(WebAssembly.validate(bytes), false)
      const message = trap(() => open(bytes), /.+/)
      open(controls); recover(); return {message}
    })
  }
  const md4 = await load('webpack-md4.wasm')
  const nativeHash = new WebAssembly.Instance(new WebAssembly.Module(md4)).exports
  const digest = (bytes, invoke, mem) => {
    invoke('init')
    let offset = 0
    while (bytes.length - offset >= 64) {
      const length = Math.min(65536, (bytes.length - offset) & ~63)
      mem().set(bytes.subarray(offset, offset + length), 0); invoke('update', length); offset += length
    }
    mem().set(bytes.subarray(offset), 0); invoke('final', bytes.length - offset)
    return new TextDecoder().decode(mem().subarray(0, 32))
  }
  const inputs = [new Uint8Array(), new TextEncoder().encode('abc'), new TextEncoder().encode('Hello 🌎, 你好'),
    ...[55, 56, 63, 64, 65, 65535, 65536, 65537, 131137].map(n => Uint8Array.from({length: n}, (_, i) => i * 31 & 255))]
  for (const [index, bytes] of inputs.entries()) {
    await check(`Webpack MD4 native match ${index} (${bytes.length} bytes)`, () => {
      open(md4, 100_000_000)
      const expected = digest(bytes, (name, ...args) => nativeHash[name](...args), () => new Uint8Array(nativeHash.memory.buffer))
      const actual = digest(bytes, call, memory)
      equal(actual, expected)
      equal(digest(bytes, call, memory), expected)
      if (index === 0) equal(actual, '31d6cfe0d16ae931b73c59d7e0c089c0')
      if (index === 1) equal(actual, 'a448017aaf21d8525fc10ae87aa6729d')
      return {digest: actual, gasUsed: engine._probe_used()}
    })
  }
  await check('100 create and close cycles recover after traps', () => {
    for (let i = 0; i < 100; i++) {
      open(controls, 1000); trap(() => call('loop'), /gas/i); recover(); engine._probe_close()
    }
    return {heapBytes: engine.HEAPU8.buffer.byteLength}
  })
  await check('single-bit mutation validation rejects native-invalid modules', () => {
    let accepted = 0, rejected = 0, nativeValidRejected = 0
    const disagreements = []
    const nativeValidRejections = []
    for (let offset = 0; offset < controls.length; offset++) for (let bit = 0; bit < 8; bit++) {
      const bytes = Uint8Array.from(controls); bytes[offset] ^= 1 << bit
      const valid = WebAssembly.validate(bytes)
      let failure
      try { open(bytes, 1000) } catch (error) { failure = String(error) }
      if (failure) {
        rejected++
        if (valid) { nativeValidRejected++; nativeValidRejections.push({offset, bit, error: failure}) }
      }
      else { accepted++; if (!valid) disagreements.push({offset, bit}) }
      engine._probe_close()
    }
    open(controls); recover()
    if (disagreements.length) throw Error('Accepted native-invalid modules: ' + JSON.stringify(disagreements))
    return {mutations: controls.length * 8, accepted, rejected, nativeValidRejected, nativeValidRejections, disagreements}
  })
  return {scope: 'Standalone Wasm3 interpreter, not integrated guest WebAssembly', results,
    passed: results.filter(row => row.passed).length, failed: results.filter(row => !row.passed).length}
}
