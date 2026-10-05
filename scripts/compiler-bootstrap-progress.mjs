import assert from 'node:assert/strict'

// Add metadata at existing await boundaries. Keep the pinned loader, its
// promises, worker pool, WASM, errors and cleanup behavior unchanged.
export function addCompilerBootstrapProgress(source,progressModule){
  assert.equal(typeof source,'string')
  assert.equal(typeof progressModule,'string')
  assert.ok(progressModule.length)
  assert.ok(!source.includes('__nativeCompilerBootstrap'),'Compiler startup metadata already present')
  const edits=[
    ['const __wasmResponse = await globalThis.fetch(__wasmUrl)',
      '__nativeCompilerBootstrap("fetching-wasm")\nconst __wasmResponse = await globalThis.fetch(__wasmUrl)'],
    ['const __wasmFile = await __wasmResponse.arrayBuffer()',
      '__nativeCompilerBootstrap("reading-wasm")\nconst __wasmFile = await __wasmResponse.arrayBuffer()\n__nativeCompilerBootstrap("wasm-bytes-ready")'],
    ['const __sharedMemory = new WebAssembly.Memory({',
      '__nativeCompilerBootstrap("allocating-memory")\nconst __sharedMemory = new WebAssembly.Memory({'],
    ['const __asyncWorkPoolSize = 4',
      '__nativeCompilerBootstrap("memory-ready")\nconst __asyncWorkPoolSize = 4'],
    ['  ;({\n    instance: __napiInstance,',
      '  __nativeCompilerBootstrap("initializing-wasi")\n  ;({\n    instance: __napiInstance,'],
    ['      __wasiWorkers.add(worker)',
      '      __wasiWorkers.add(worker)\n      __observeNativeCompilerWorker(worker, ++__nativeCompilerWorkerId)'],
    ['  __publishWasiDispose(__napiModule.exports)',
      '  __publishWasiDispose(__napiModule.exports)\n  __nativeCompilerBootstrap("binding-ready")'],
  ]
  for(const [before,after] of edits){
    assert.equal(source.split(before).length,2,'Pinned compiler startup boundary changed: '+before.split('\n')[0])
    source=source.replace(before,after)
  }
  return `import {reportCompilerBootstrap as __nativeCompilerBootstrap,observeCompilerBootstrapWorker as __observeNativeCompilerWorker} from ${JSON.stringify(progressModule)}\nlet __nativeCompilerWorkerId=0\n`+source
}
