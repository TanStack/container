(() => {
  const native = globalThis.__nativeWasm
  const sharedMemoryEnabled=globalThis.__nativeSharedWasmMemory===true
  delete globalThis.__nativeSharedWasmMemory
  const profile = globalThis.__profileWasm
  const measure = globalThis.__measureWasm
  delete globalThis.__measureWasm
  delete globalThis.__profileWasm
  delete globalThis.__nativeWasm
  if (!native) return
  const memoryToken = Symbol('WASM memory construction')
  const globalToken = Symbol('WASM global construction')
  const tableToken = Symbol('WASM table construction')
  const functionCache = new WeakMap(), functionStates = new WeakMap(), tableCache = new WeakMap()
  let moduleHandle, moduleBytes, isModule, memoryHandle, isMemory, globalHandle, isGlobal, tableHandle, isTable
  const kinds = ['function', 'table', 'memory', 'global']
  class CompileError extends Error { name = 'CompileError' }
  class LinkError extends Error { name = 'LinkError' }
  class RuntimeError extends Error { name = 'RuntimeError' }
  const bridgeHelper = (kind, value, index) => {
    if (kind === 'results') return [...value]
    if (kind === 'function') return getFunction(value, index)
    const Constructor = kind === 'CompileError' ? CompileError : kind === 'LinkError' ? LinkError : RuntimeError
    return new Constructor(value)
  }
  let profileScope
  const measuredNative = (op, owner, arg, extra) => {
    if (!measure || (op !== 0 && op !== 2 && op !== 3)) return native(op, owner, arg, extra, bridgeHelper)
    const started = measure(-1, op)
    try { return native(op, owner, arg, extra, bridgeHelper) }
    finally { measure(op, started) }
  }
  const invoke = (op, owner, arg, extra) => {
    if (!profile || (op !== 0 && op !== 2 && op !== 3)) return measuredNative(op, owner, arg, extra)
    const started = profile(-1)
    const previous = profileScope
    const scope = profileScope = {importsMs: 0, imports: 0}
    try { return native(op, owner, arg, extra, bridgeHelper) }
    finally {
      profileScope = previous
      profile(op, started, scope.importsMs, scope.imports)
    }
  }
  const getFunction = (owner, index) => {
    let cache = functionCache.get(owner)
    if (!cache) functionCache.set(owner, cache = new Map())
    if (!cache.has(index)) {
      const fn = (...args) => invoke(3, owner, index, args)
      functionStates.set(fn, {owner, index}); cache.set(index, fn)
    }
    return cache.get(index)
  }
  const functionDescriptor = value => {
    if (value === null) return null
    const descriptor = functionStates.get(value)
    if (!descriptor) throw new TypeError('Expected an exported WASM function or null')
    return descriptor
  }
  const applyIntrinsic = Reflect.apply
  const isBufferView = ArrayBuffer.isView
  const ByteView = Uint8Array
  const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  const typedArrayGetters = ['buffer', 'byteOffset', 'byteLength'].map(name => Object.getOwnPropertyDescriptor(typedArrayPrototype, name).get)
  const dataViewGetters = ['buffer', 'byteOffset', 'byteLength'].map(name => Object.getOwnPropertyDescriptor(DataView.prototype, name).get)
  const bytes = source => {
    let buffer, offset, length
    if (isBufferView(source)) {
      let getters = typedArrayGetters
      try { buffer = applyIntrinsic(getters[0], source, []) }
      catch { getters = dataViewGetters; buffer = applyIntrinsic(getters[0], source, []) }
      offset = applyIntrinsic(getters[1], source, [])
      length = applyIntrinsic(getters[2], source, [])
    } else {
      try { length = applyIntrinsic(arrayBufferLength, source, []) }
      catch { throw new TypeError('Expected an ArrayBuffer or typed array') }
      buffer = source; offset = 0
    }
    // A view allocates no backing bytes and rejects detached ArrayBuffers even
    // when their intrinsic byteLength has become zero. Shared views stay valid.
    new ByteView(buffer, offset, length)
    return {buffer, offset, length}
  }
  class Module {
    #handle
    constructor(source) { const input=bytes(source);this.#handle = invoke(0, input.buffer, input.offset, input.length) }
    static {
      moduleHandle = module => module.#handle
      moduleBytes = module => invoke(22, module.#handle)
      isModule = value => value !== null && (typeof value === 'object' || typeof value === 'function') && #handle in value
    }
    static exports(module) { return invoke(1, moduleHandle(module)).map(({name, kind}) => ({name, kind: kinds[kind]})) }
    static imports(module) { return invoke(6, moduleHandle(module)).map(({module, name, kind}) => ({module, name, kind: kinds[kind]})) }
  }
  class Memory {
    #handle
    #sharedBuffer
    #sharedGeneration=-1
    #shared=false
    constructor(token, state) {
      if (token === memoryToken) { this.#handle = state; this.#shared=sharedMemoryEnabled&&invoke(21,state)>=0; return }
      if (token === null || (typeof token !== 'object' && typeof token !== 'function')) throw new TypeError('Expected a memory descriptor')
      const address = token.address
      if (address !== undefined && String(address) !== 'i32') throw new TypeError('Only wasm32 memory is supported')
      const initial = memoryIndex(token.initial)
      if (initial > 65536) throw new RangeError('Invalid memory minimum')
      const maximumValue = token.maximum
      const maximum = maximumValue === undefined ? undefined : memoryIndex(maximumValue)
      if (maximum !== undefined && (maximum > 65536 || maximum < initial)) throw new RangeError('Invalid memory maximum')
      const shared=!!token.shared
      if(shared&&!sharedMemoryEnabled)throw new TypeError('Shared WASM memory is not supported')
      if(shared&&maximum===undefined)throw new TypeError('Shared WASM memory requires a maximum')
      this.#handle = invoke(8, initial, maximum, shared)
      this.#shared=shared
    }
    static {
      memoryHandle = memory => memory.#handle
      isMemory = value => value !== null && (typeof value === 'object' || typeof value === 'function') && #handle in value
    }
    get buffer() {
      if(this.#shared){
        const generation=invoke(21,this.#handle)
        if(!this.#sharedBuffer||this.#sharedGeneration!==generation){this.#sharedBuffer=invoke(4,this.#handle);this.#sharedGeneration=generation}
        return this.#sharedBuffer
      }
      return invoke(4, this.#handle)
    }
    grow(delta) {
      const handle = this.#handle
      return invoke(5, handle, memoryIndex(delta))
    }
  }
  const memoryIndex = value => {
    const number = +value
    if (!Number.isFinite(number) || number < 0 || number >= 4294967296) throw new TypeError('Invalid memory page count')
    return Math.trunc(number)
  }
  class Global {
    #handle
    constructor(descriptor, initialValue) {
      if (descriptor === globalToken) { this.#handle = initialValue; return }
      if (descriptor === null || (typeof descriptor !== 'object' && typeof descriptor !== 'function')) throw new TypeError('Expected a global descriptor')
      const mutable = !!descriptor.mutable
      const typeName = String(descriptor.value)
      const type = ['i32', 'i64', 'f32', 'f64'].indexOf(typeName) + 1
      if (!type) throw new TypeError('Only numeric WASM globals are supported')
      this.#handle = invoke(10, type, mutable, initialValue === undefined ? type === 2 ? 0n : 0 : initialValue)
    }
    static {
      globalHandle = global => global.#handle
      isGlobal = value => value !== null && (typeof value === 'object' || typeof value === 'function') && #handle in value
    }
    get value() { return invoke(11, this.#handle) }
    set value(value) { invoke(12, this.#handle, value) }
    valueOf() { return invoke(11, this.#handle) }
  }
  class Instance {
    #exports
    constructor(module, imports = {}) {
      if (imports === null || (typeof imports !== 'object' && typeof imports !== 'function')) throw new TypeError('Invalid imports object')
      const callbacks = [], memories = [], globals = [], tables = [], memoryObjects = new Map(), globalObjects = new Map()
      const moduleState = moduleHandle(module)
      // Collect import properties before linking or converting their values.
      // A later throwing getter must win over an earlier link type mismatch.
      const inputs = invoke(6, moduleState).map(descriptor => {
        const {module: namespaceName, name} = descriptor
        const namespace = imports[namespaceName]
        if (namespace === null || (typeof namespace !== 'object' && typeof namespace !== 'function')) throw new TypeError('WASM import module must be an object')
        return {...descriptor, value: namespace[name]}
      })
      for (const {kind, type, mutable, value} of inputs) {
        if (kind === 1) {
          if (!isTable(value)) throw new LinkError('WASM table import must be a WebAssembly.Table')
          tables.push(tableHandle(value))
        } else if (kind === 2) {
          if (!isMemory(value)) throw new LinkError('WASM memory import must be a WebAssembly.Memory')
          memoryObjects.set(memories.length, value); memories.push(memoryHandle(value))
        } else if (kind === 3) {
          let handle
          if (isGlobal(value)) {
            handle = globalHandle(value)
            if (!invoke(14, handle, type, mutable)) throw new LinkError('WASM global import type or mutability does not match')
            globalObjects.set(globals.length, value)
          } else {
            if (mutable || typeof value !== (type === 2 ? 'bigint' : 'number')) throw new LinkError('WASM global import must have the declared value type')
            handle = invoke(10, type, false, value)
          }
          globals.push(handle)
        } else {
          if (typeof value !== 'function') throw new LinkError('WASM function import must be callable')
          callbacks.push(profile ? (...args) => {
            const started = profile(-1)
            const scope = profileScope
            try { return Reflect.apply(value, undefined, args) }
            finally {
              if (scope) { scope.importsMs += profile(-1) - started; scope.imports++ }
              profile(4, started)
            }
          } : value)
        }
      }
      const handle = invoke(2, moduleState, callbacks, {memories, globals, tables}), exports = Object.create(null)
      for (const {name, kind, index} of invoke(1, handle)) {
        let value
        if (kind === 0) {
          value = getFunction(handle, index)
        } else if (kind === 1) {
          const state = invoke(20, handle, index)
          if (!tableCache.has(state)) tableCache.set(state, new Table(tableToken, state))
          value = tableCache.get(state)
        } else if (kind === 2) {
          if (!memoryObjects.has(index)) {
            value = new Memory(memoryToken, invoke(7, handle, index)); memoryObjects.set(index, value)
          }
          value = memoryObjects.get(index)
        } else if (kind === 3) {
          value = globalObjects.has(index) ? globalObjects.get(index) : new Global(globalToken, invoke(9, handle, index))
        } else throw new LinkError('Exported WASM tables and globals are not supported in this spike')
        Object.defineProperty(exports, name, {value, enumerable: true})
      }
      Object.preventExtensions(exports); this.#exports = exports
    }
    get exports() {
      return this.#exports
    }
  }
  class Table {
    #handle
    constructor(descriptor, initialValue) {
      if (descriptor === tableToken) { this.#handle = initialValue; return }
      if (descriptor === null || (typeof descriptor !== 'object' && typeof descriptor !== 'function')) throw new TypeError('Expected a table descriptor')
      if (String(descriptor.element) !== 'anyfunc') throw new TypeError('Only function tables are supported')
      const initial = memoryIndex(descriptor.initial)
      const maximumValue = descriptor.maximum
      const maximum = maximumValue === undefined ? undefined : memoryIndex(maximumValue)
      if (maximum !== undefined && initial > maximum) throw new RangeError('Invalid table limits')
      this.#handle = invoke(15, initial, maximum, functionDescriptor(initialValue === undefined ? null : initialValue))
      tableCache.set(this.#handle, this)
    }
    static {
      tableHandle = table => table.#handle
      isTable = value => value !== null && (typeof value === 'object' || typeof value === 'function') && #handle in value
    }
    get length() { return invoke(16, this.#handle) }
    get(index) { const state = this.#handle; return invoke(17, state, memoryIndex(index)) }
    set(index, value) {
      const state = this.#handle, offset = memoryIndex(index)
      if (offset >= invoke(16, state)) throw new RangeError('Table index out of bounds')
      return invoke(18, state, offset, functionDescriptor(arguments.length < 2 ? null : value))
    }
    grow(delta, value) { const state = this.#handle; return invoke(19, state, memoryIndex(delta), functionDescriptor(arguments.length < 2 ? null : value)) }
  }
  Object.defineProperty(Memory.prototype,Symbol.toStringTag,{value:'WebAssembly.Memory',configurable:true})
  Object.defineProperty(Module.prototype,Symbol.toStringTag,{value:'WebAssembly.Module',configurable:true})
  if(globalThis.__webContainerHost){
    // Modules clone their immutable source bytes. Each receiving runtime owns
    // its compiled module; compiled native handles never cross runtimes.
    globalThis.__webContainerHost.wasmModule={isModule,handle:moduleHandle,bytes:moduleBytes,fromBytes:source=>new Module(source)}
  }
  if (sharedMemoryEnabled && globalThis.__webContainerHost?.shared) {
    globalThis.__webContainerHost.shared.wasmMemory = {
      isMemory,
      unwrap: memoryHandle,
      wrap(handle) {
        if (invoke(21, handle) < 0) throw new TypeError('Expected shared WASM memory')
        return new Memory(memoryToken, handle)
      },
    }
  }
  globalThis.WebAssembly = {
    Module, Instance, Memory, Global, Table, CompileError, LinkError, RuntimeError,
    validate(source) { const input = bytes(source); try { invoke(0, input.buffer, input.offset, input.length); return true } catch (error) { if (error.name === 'CompileError') return false; throw error } },
    async compile(source) { return new Module(source) },
    async instantiate(source, imports) {
      if (isModule(source)) return new Instance(source, imports)
      const module = new Module(source)
      return {module, instance: new Instance(module, imports)}
    },
  }
})()
