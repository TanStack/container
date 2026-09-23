// The native harness collects between separate guest calls. These tests do not
// assert when a JavaScript implementation must choose to collect garbage.
export const weakmapLifetimeCases = [
  {name: 'dead object key without back-reference', setup: 'const map = new WeakMap()',
    step: 'const key = {}; map.set(key, {buffer: new Uint8Array(65536)})'},
  {name: 'dead object key with direct back-reference', setup: 'const map = new WeakMap()',
    step: 'const key = {}; map.set(key, {buffer: new Uint8Array(65536), key})'},
  {name: 'dead object key reached through closure and Map', setup: 'const map = new WeakMap()',
    step: 'const key = {}; map.set(key, new Map([[0, () => key], [1, new Uint8Array(65536)]]))'},
  {name: 'key is its own value', setup: 'const map = new WeakMap()',
    step: 'const key = {buffer: new Uint8Array(65536)}; map.set(key, key)'},
  {name: 'mutual keys across rooted WeakMaps', setup: 'const a = new WeakMap(), b = new WeakMap()',
    step: 'const x = {}, y = {}; a.set(x, {key: y, buffer: new Uint8Array(65536)}); b.set(y, x)'},
  {name: 'live key preserves value until released', setup: 'const map = new WeakMap(); let key = {}',
    step: 'const buffer = new Uint8Array(65536); buffer[0] = 17; map.set(key, {key, buffer})',
    check: 'if (map.get(key).buffer[0] !== 17) throw Error("lost live value")', release: 'key = null'},
  {name: 'externally retained value survives dead key', setup: 'const map = new WeakMap(); let value',
    step: 'value = new Uint8Array(65536); value[0] = 19; map.set({}, value)',
    check: 'if (value[0] !== 19) throw Error("lost rooted value")', release: 'value = null'},
  {name: 'reverse-ordered weak chain reaches fixed point',
    setup: 'const maps = Array.from({length: 12}, () => new WeakMap()); let root = {}',
    step: `let key = root; for (let i = maps.length - 1; i >= 0; i--) {
      const next = {buffer: new Uint8Array(65536)}; next.buffer[0] = i;
      maps[i].set(key, next); key = next;
    }`,
    check: `let key = root; for (let i = maps.length - 1; i >= 0; i--) {
      key = maps[i].get(key); if (!key || key.buffer[0] !== i) throw Error('lost weak chain');
    }`, release: 'root = null'},
  {name: 'WeakMap reached only through another weak value', setup: 'const outer = new WeakMap(); let key = {}',
    step: 'const inner = new WeakMap(), child = {}; inner.set(child, {child, buffer: new Uint8Array(65536)}); outer.set(key, {inner, child})',
    check: 'const value = outer.get(key); if (value.inner.get(value.child).buffer.length !== 65536) throw Error("lost nested map")',
    release: 'key = null'},
  {name: 'dead WeakMap with live key and map cycle', setup: 'const key = {}',
    step: 'const map = new WeakMap(); map.set(key, {map, buffer: new Uint8Array(65536)})'},
  {name: 'replacement and explicit deletion', setup: 'const map = new WeakMap(); const key = {}',
    step: `map.set(key, {key, buffer: new Uint8Array(65536)});
      map.set(key, {key, buffer: new Uint8Array(65536)});
      if (!map.delete(key) || map.has(key)) throw Error('delete failed')`},
  {name: 'WeakRef no longer sees unreachable object-key cycle', setup: 'const map = new WeakMap(); let ref',
    step: 'const key = {}; ref = new WeakRef(key); map.set(key, {key, buffer: new Uint8Array(65536)})',
    check: 'if (ref.deref() !== undefined) throw Error("weak target retained")', release: 'ref = null'},
  {name: 'FinalizationRegistry receives collected object keys',
    setup: 'const map = new WeakMap(); let issued = 0, cleaned = 0; const registry = new FinalizationRegistry(() => cleaned++)',
    step: 'const key = {}; registry.register(key, ++issued); map.set(key, {key, buffer: new Uint8Array(65536)})',
    check: 'if (cleaned !== issued) throw Error("missing finalization")'},
  {name: 'FinalizationRegistry holding preserves reachable key',
    setup: 'const map = new WeakMap(); const target = {}; let ref; const registry = new FinalizationRegistry(() => {})',
    step: 'const key = {}; registry.unregister(target); registry.register(target, key, target); map.set(key, new Uint8Array(65536)); ref = new WeakRef(key)',
    check: 'if (map.get(ref.deref()).length !== 65536) throw Error("lost held key")',
    release: 'ref = null; registry.unregister(target)'},
  {name: 'live symbol key preserves value', setup: 'const map = new WeakMap(); const key = Symbol("live")',
    step: 'map.set(key, new Uint8Array(65536))',
    check: 'if (map.get(key).length !== 65536) throw Error("lost symbol value")', release: 'map.delete(key)'},
  {name: 'dead symbol key without back-reference', setup: 'const map = new WeakMap()',
    step: 'map.set(Symbol("dead"), new Uint8Array(65536))'},
  {name: 'dead symbol key with back-reference', setup: 'const map = new WeakMap()',
    step: 'const key = Symbol("cycle"); map.set(key, {key, buffer: new Uint8Array(65536)})', knownGap: true},
]

export const weakmapLifetimeSource = `globalThis.cases = [${weakmapLifetimeCases.map(test =>
  `() => { ${test.setup}; return {
    step() { ${test.step} }, check() { ${test.check ?? ''} }, release() { ${test.release ?? ''} }
  } }`).join(',\n')}];`
