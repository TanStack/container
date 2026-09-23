import {cpSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

// Extend the pinned wrapper in its private build copy, never node_modules or
// the canonical source checkout. Only host code can invoke this method.
export function stageInspectionWrapper(source,directory,{fibers=false,sharedStorage=false,guestWasm=false,compiledInitializers=false}={}){
  const target=join(directory,'inspection-core')
  cpSync(join(source,'packages/quickjs-emscripten-core/src'),target,{recursive:true})
  if(sharedStorage){
    const moduleFile=join(target,'module.ts'),moduleSource=readFileSync(moduleFile,'utf8')
    const moduleMarker='export class QuickJSWASMModule {'
    if(moduleSource.split(moduleMarker).length!==2)throw Error('Unexpected shared budget module integration site')
    writeFileSync(moduleFile,moduleSource.replace(moduleMarker,moduleMarker+`
  /** Host-only, immutable budget for this outer engine, not all kernel engines. */
  configureSharedStorage(maxBytes: number, growthReservation = false): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 65536 || maxBytes > 1536 * 1024 * 1024)
      throw new RangeError("Invalid per-engine shared memory budget")
    if (typeof growthReservation !== "boolean") throw new TypeError("Invalid shared memory growth reservation")
    const reserve = this.module.cwrap("QTS_ConfigureSharedStorageReservation", "number", ["number"])
    if (!reserve(Number(growthReservation))) throw new Error("Shared memory reservation is already fixed")
    const configure = this.module.cwrap("QTS_ConfigureSharedStorage", "number", ["number"])
    if (!configure(maxBytes)) throw new Error("Shared memory budget is already fixed")
  }
`))
  }
  const file=join(target,'context.ts'),original=readFileSync(file,'utf8')
  const marker='  protected success<S>(value: S): DisposableSuccess<S> {'
  if(original.split(marker).length!==2)throw Error('Unexpected QuickJS context extension site')
  const method=`  /** Initialize trusted builtins with a private engine inspection binding. */
  initializeInspection(initializer: QuickJSHandle): QuickJSContextResult<QuickJSHandle> {
    this.runtime.assertOwned(initializer)
    const initialize = this.module.cwrap("QTS_InitializeInspection", "number", ["number", "number"])
    const resultPtr = initialize(this.ctx.value, initializer.value) as JSValuePointer
    const errorPtr = this.ffi.QTS_ResolveException(this.ctx.value, resultPtr)
    if (errorPtr) {
      this.ffi.QTS_FreeValuePointer(this.ctx.value, resultPtr)
      return this.fail(this.memory.heapValueHandle(errorPtr))
    }
    return this.success(this.memory.heapValueHandle(resultPtr))
  }

`
  const cryptoMethod=method.replaceAll('Inspection','Crypto').replace('inspection binding','crypto binding')
  const terminationMethod=method.replaceAll('Inspection','Termination').replace('inspection binding','termination binding')
  const fiberMethod=fibers?method.replaceAll('Inspection','Fiber').replace('inspection binding','fiber park binding'):''
  const fiberCall=fibers?`  private activeFiberCalls = 0

  /** Experimental scheduler-owned call. Dispose before disposing this runtime. */
  startFiberCall(func: QuickJSHandle, thisVal: QuickJSHandle = this.undefined) {
    this.runtime.assertOwned(func)
    this.runtime.assertOwned(thisVal)
    const create = this.module.cwrap("QTS_FiberCreate", "number", ["number", "number", "number"])
    return this.wrapFiberCall(create(this.ctx.value, func.value, thisVal.value))
  }

  /** Experimental evaluation with the regular QTS_Eval module semantics. */
  startFiberEval(source: string, filename: string, flags = 1) {
    const create = this.module.cwrap("QTS_FiberCreateEval", "number", ["number", "string", "string", "number"])
    return this.wrapFiberCall(create(this.ctx.value, source, filename, flags))
  }

  private wrapFiberCall(pointer: number) {
    const bind = (name: string, result: string | null, args: string[]) => this.module.cwrap(name, result as any, args as any) as (...args: number[]) => number
    const step = bind("QTS_FiberStep", null, ["number"])
    const status = bind("QTS_FiberStatus", "number", ["number"])
    const deliver = bind("QTS_FiberDeliver", "number", ["number", "number"])
    const cancel = bind("QTS_FiberCancel", "number", ["number"])
    const take = bind("QTS_FiberTakeResult", "number", ["number"])
    const dispose = bind("QTS_FiberDispose", "number", ["number"])
    if (!pointer) throw new Error("Cannot create fiber call")
    this.activeFiberCalls++
    this.runtime.retainFiberCall()
    let alive = true
    const assertAlive = () => { if (!alive) throw new Error("Fiber call disposed") }
    return {
      ${sharedStorage?`atomicWait: () => {
        assertAlive()
        return bind("QTS_FiberAtomicPending", "number", ["number"])(pointer)
          ? bind("QTS_FiberAtomicTimeout", "number", ["number"])(pointer) : undefined
      },
      atomicReady: () => { assertAlive(); return Boolean(bind("QTS_FiberAtomicReady", "number", ["number"])(pointer)) },`:''}
      step: () => { assertAlive(); step(pointer); return status(pointer) },
      status: () => { assertAlive(); return status(pointer) },
      deliver: (value: number) => {
        assertAlive()
        if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Expected int32 fiber result")
        return Boolean(deliver(pointer, value))
      },
      cancel: () => { assertAlive(); return Boolean(cancel(pointer)) },
      takeResult: (): QuickJSContextResult<QuickJSHandle> => {
        assertAlive()
        const resultPtr = take(pointer) as JSValuePointer
        if (!resultPtr) throw new Error("Fiber result is not available")
        const errorPtr = this.ffi.QTS_ResolveException(this.ctx.value, resultPtr)
        if (errorPtr) {
          this.ffi.QTS_FreeValuePointer(this.ctx.value, resultPtr)
          return this.fail(this.memory.heapValueHandle(errorPtr))
        }
        return this.success(this.memory.heapValueHandle(resultPtr))
      },
      dispose: () => {
        assertAlive()
        if (!dispose(pointer)) throw new Error("Fiber must finish and transfer its result before disposal")
        this.activeFiberCalls--
        this.runtime.releaseFiberCall()
        alive = false
      },
    }
  }

`:''
  const sharedLeaseMethod=(method,prefix)=>`  /** Host-owned queued message reference; survives source runtime disposal. */
  ${method}(value: QuickJSHandle) {
    this.runtime.assertOwned(value)
    const module = this.module
    const retain = module.cwrap("${prefix}Retain", "number", ["number", "number"])
    const adopt = module.cwrap("${prefix}Adopt", "number", ["number", "number"])
    const release = module.cwrap("${prefix}Release", "number", ["number"])
    const resultPtr = retain(this.ctx.value, value.value) as JSValuePointer
    const errorPtr = this.ffi.QTS_ResolveException(this.ctx.value, resultPtr)
    if (errorPtr) {
      this.ffi.QTS_FreeValuePointer(this.ctx.value, resultPtr)
      const error = this.memory.heapValueHandle(errorPtr)
      try { throw new Error(String(this.dump(error)?.message ?? "Cannot retain shared buffer")) } finally { error.dispose() }
    }
    const idHandle = this.memory.heapValueHandle(resultPtr)
    const id = this.getNumber(idHandle)
    idHandle.dispose()
    let alive = true
    return {
      get alive() { return alive },
      adopt: (target: QuickJSContext): QuickJSContextResult<QuickJSHandle> => {
        if (!alive) throw new Error("Shared message lease already consumed")
        if (module !== target.module) throw new Error("Shared buffers require the same engine")
        const resultPtr = adopt(target.ctx.value, id) as JSValuePointer
        const errorPtr = target.ffi.QTS_ResolveException(target.ctx.value, resultPtr)
        if (errorPtr) {
          target.ffi.QTS_FreeValuePointer(target.ctx.value, resultPtr)
          return target.fail(target.memory.heapValueHandle(errorPtr))
        }
        alive = false
        return target.success(target.memory.heapValueHandle(resultPtr))
      },
      dispose: () => {
        if (!alive) return
        if (!release(id)) throw new Error("Shared message lease missing")
        alive = false
      },
    }
  }

`
  const sharedMethods=sharedStorage?sharedLeaseMethod('retainSharedBuffer','QTS_Shared')+
    (guestWasm?sharedLeaseMethod('retainSharedWasmMemory','QTS_SharedWasm'):'')+`  /** Trusted same-engine aliasing, not a guest serialization API. */
  cloneSharedBufferFrom(source: QuickJSContext, value: QuickJSHandle): QuickJSContextResult<QuickJSHandle> {
    source.runtime.assertOwned(value)
    if (this.module !== source.module) throw new Error("Shared buffers require the same engine")
    const clone = this.module.cwrap("QTS_SharedClone", "number", ["number", "number", "number"])
    const resultPtr = clone(this.ctx.value, source.ctx.value, value.value) as JSValuePointer
    const errorPtr = this.ffi.QTS_ResolveException(this.ctx.value, resultPtr)
    if (errorPtr) {
      this.ffi.QTS_FreeValuePointer(this.ctx.value, resultPtr)
      return this.fail(this.memory.heapValueHandle(errorPtr))
    }
    return this.success(this.memory.heapValueHandle(resultPtr))
  }
  sharedStorageStats(): QuickJSContextResult<QuickJSHandle> {
    const stats = this.module.cwrap("QTS_SharedStats", "number", ["number"])
    const resultPtr = stats(this.ctx.value) as JSValuePointer
    const errorPtr = this.ffi.QTS_ResolveException(this.ctx.value, resultPtr)
    if (errorPtr) {
      this.ffi.QTS_FreeValuePointer(this.ctx.value, resultPtr)
      return this.fail(this.memory.heapValueHandle(errorPtr))
    }
    return this.success(this.memory.heapValueHandle(resultPtr))
  }

`:''
  let contextSource=original.replace(marker,method+cryptoMethod+terminationMethod+fiberMethod+fiberCall+sharedMethods+marker)
  if(fibers){
    const contextDispose='  dispose() {\n    this.memory.dispose()\n  }'
    if(contextSource.split(contextDispose).length!==2)throw Error('Unexpected context disposal site')
    contextSource=contextSource.replace(contextDispose,'  dispose() {\n    if (this.activeFiberCalls) throw new Error("Dispose fiber calls before their context")\n    this.memory.dispose()\n  }')
    const runtimeFile=join(target,'runtime.ts'),runtimeSource=readFileSync(runtimeFile,'utf8')
    const runtimeDispose='  dispose() {\n    return this.scope.dispose()\n  }'
    if(runtimeSource.split(runtimeDispose).length!==2)throw Error('Unexpected runtime disposal site')
    writeFileSync(runtimeFile,runtimeSource.replace(runtimeDispose,`  private activeFiberCalls = 0
  /** @internal */
  retainFiberCall() { this.activeFiberCalls++ }
  /** @internal */
  releaseFiberCall() { this.activeFiberCalls-- }
  dispose() {
    if (this.activeFiberCalls) throw new Error("Dispose fiber calls before their runtime")
    return this.scope.dispose()
  }`))
  }
  if(compiledInitializers){
    const methods=['Compile','Eval'].map(operation=>method
      .replace('initializeInspection',operation.toLowerCase()+'TrustedInitializer')
      .replace('QTS_InitializeInspection','QTS_'+operation+'TrustedInitializer')
      .replace('Initialize trusted builtins with a private engine inspection binding.','Host-only same-engine initializer bridge, never expose to guest code.')).join('')
    const namedMethod=method
      .replace('initializeInspection(initializer: QuickJSHandle)', 'compileTrustedInitializerWithFilename(initializer: QuickJSHandle, filename: QuickJSHandle)')
      .replace('this.runtime.assertOwned(initializer)', 'this.runtime.assertOwned(initializer)\n    this.runtime.assertOwned(filename)')
      .replace('QTS_InitializeInspection', 'QTS_CompileTrustedInitializerWithFilename')
      .replace('["number", "number"]', '["number", "number", "number"]')
      .replace('initialize(this.ctx.value, initializer.value)', 'initialize(this.ctx.value, initializer.value, filename.value)')
      .replace('Initialize trusted builtins with a private engine inspection binding.', 'Host-only same-engine compilation with bounded filename attribution.')
    contextSource=contextSource.replace(marker,methods+namedMethod+marker)
  }
  writeFileSync(file,contextSource)
  const asyncFile=join(target,'context-asyncify.ts'),asyncSource=readFileSync(asyncFile,'utf8')
  const asyncMarker='  async evalCodeAsync('
  if(asyncSource.split(asyncMarker).length!==2)throw Error('Unexpected asynchronous call extension site')
  writeFileSync(asyncFile,asyncSource.replace(asyncMarker,`  async callFunctionAsync(func: QuickJSHandle, thisVal: QuickJSHandle, ...args: QuickJSHandle[]): Promise<QuickJSContextResult<QuickJSHandle>> {
    this.runtime.assertOwned(func)
    this.runtime.assertOwned(thisVal)
    for (const arg of args) this.runtime.assertOwned(arg)
    const pointers = this.memory.toPointerArray(args)
    let resultPtr: JSValuePointer
    try {
      resultPtr = await this.ffi.QTS_Call_MaybeAsync(this.ctx.value, func.value, thisVal.value, args.length, pointers.value)
    } finally { pointers.dispose() }
    const errorPtr = this.ffi.QTS_ResolveException(this.ctx.value, resultPtr)
    if (errorPtr) {
      this.ffi.QTS_FreeValuePointer(this.ctx.value, resultPtr)
      return this.fail(this.memory.heapValueHandle(errorPtr))
    }
    return this.success(this.memory.heapValueHandle(resultPtr))
  }

`+asyncMarker))
  return join(target,'index.ts')
}
