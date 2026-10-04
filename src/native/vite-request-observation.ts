type Listener = (...args: any[]) => void
type Emitter = {prependListener: (name: string, callback: Listener) => unknown;
  once: (name: string, callback: Listener) => unknown; off: (name: string, callback: Listener) => unknown}
type Environment = {transformRequest: (...args: any[]) => Promise<unknown>;
  pluginContainer?: object & {plugins?: readonly object[]}; moduleGraph?: object}
type Server = {httpServer?: Emitter | null; environments: Record<string, Environment>}
type Row = Record<string, unknown>

/** Opt-in diagnostics. No extra guest requests, body reads or retries. */
export function observeViteRequests(server: Server, emit: (row: Row) => void,
  {now = () => performance.now(), maxEvents = 4096, maxPending = 128, innerStages = false, callbackStages = false} = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 8192 ||
    !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 256)
    throw TypeError('Invalid Vite observation limits')
  const started = now(), http = new Map<number, Row>(), transforms = new Map<number, Row>(), stages = new Map<number, Row>()
  const cleanups = new Set<() => void>(), restores: (() => void)[] = []
  let id = 0, events = 0, dropped = 0, pendingDropped = 0, disposed = false
  let stagesStarted = 0, stagesSettled = 0
  let callbacksStarted = 0, callbacksSettled = 0, callbackTailDropped = 0
  const callbackTail: Row[] = []
  const safe = (callback: () => void) => { try { callback() } catch {} }
  const at = () => Math.round(now() - started)
  const pathname = (value: unknown) => {
    if (typeof value !== 'string') return undefined
    if (/^(?:data|blob):/i.test(value)) return '<inline module>'
    try { return new URL(value, 'http://sandbox.invalid').pathname.slice(0, 512) }
    catch { return value.split(/[?#]/, 1)[0]!.slice(0, 512) }
  }
  const specifier = (value: unknown) => {
    if (typeof value !== 'string') return undefined
    // Package imports beginning with # are module IDs, not URL fragments.
    if (value.startsWith('#')) return '#'+value.slice(1).split(/[?#]/, 1)[0]!.slice(0, 511)
    if (/^(?:https?:|data:|blob:|\/\/)/i.test(value)) return pathname(value)
    return value.split(/[?#]/, 1)[0]!.slice(0, 512)
  }
  const record = (row: Row, force = false) => {
    if (disposed) return
    if (!force && events >= maxEvents) { dropped++; return }
    events++
    safe(() => emit({...row, elapsedMs: at()}))
  }
  const remember = (map: Map<number, Row>, key: number, row: Row) => {
    if (map.size < maxPending) map.set(key, {...row, elapsedMs: at()})
    else pendingDropped++
  }
  if (callbackStages) {
    const key = Symbol.for('web-container:vite-private-callback')
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    const observe = (importId: unknown, importer: unknown, environment: unknown) => {
      const handle = ++id
      const row = {kind: 'callback-start', id: handle, method: 'resolveSubpathImports',
        environment: typeof environment === 'string' ? environment.slice(0, 120) : undefined,
        specifier: specifier(importId), importer: pathname(importer), elapsedMs: at()}
      safe(() => { callbacksStarted++; remember(stages, handle, row) })
      let settled = false
      return (outcome: unknown) => safe(() => {
        if (settled || disposed) return
        settled = true; callbacksSettled++; stages.delete(handle)
        callbackTail.push({...row, kind: 'callback-end', outcome: outcome === 'threw' ? 'threw' : 'returned', waitMs: at() - row.elapsedMs})
        if (callbackTail.length > 64) { callbackTail.shift(); callbackTailDropped++ }
      })
    }
    // Keep this hook out of normal builds and normal observation modes.
    Object.defineProperty(globalThis, key, {value: observe, configurable: true, writable: true})
    restores.push(() => {
      if (Reflect.get(globalThis, key) !== observe) return
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  const wrapStage = (target: any, method: string, environment: string, argument: number) => {
    if (!target || typeof target[method] !== 'function') return
    const original: (...args: any[]) => any = target[method]
    const descriptor = Object.getOwnPropertyDescriptor(target, method)
    const wrapper = function(this: unknown, ...args: any[]) {
      const key = ++id
      safe(() => {
        stagesStarted++
        remember(stages, key, {kind: 'stage-start', id: key, environment, method,
          ...(method === 'resolveId' ? {specifier: specifier(args[argument]), importer: pathname(args[1])} : {pathname: pathname(args[argument])})})
      })
      let settled = false
      const finish = () => safe(() => {
        if (settled || disposed) return
        settled = true; stagesSettled++; stages.delete(key)
      })
      try {
        const result = Reflect.apply(original, this, args)
        // Pending metadata only, no source, result, extra await or per-stage message.
        safe(() => { if (result?.then) void result.then(finish, finish); else finish() })
        return result
      } catch (error) { finish(); throw error }
    }
    target[method] = wrapper
    restores.push(() => {
      if (target[method] !== wrapper) return
      if (descriptor) Object.defineProperty(target, method, descriptor)
      else Reflect.deleteProperty(target, method)
    })
  }
  const wrappedPlugins = new WeakSet<object>()
  const wrapResolver = (plugin: any) => {
    if (wrappedPlugins.has(plugin)) return
    wrappedPlugins.add(plugin)
    const hook = plugin.resolveId
    const original: ((...args: any[]) => any) | undefined = typeof hook === 'function' ? hook : hook?.handler
    if (typeof original !== 'function') return
    const descriptor = Object.getOwnPropertyDescriptor(plugin, 'resolveId')
    const wrapper = function(this: any, ...args: any[]) {
      const key = ++id
      safe(() => {
        stagesStarted++
        remember(stages, key, {kind: 'stage-start', id: key, environment: this?.environment?.name,
          method: 'plugin.resolveId', plugin: String(plugin.name).slice(0, 120),
          specifier: specifier(args[0]), importer: pathname(args[1])})
      })
      let settled = false
      const finish = () => safe(() => {
        if (settled || disposed) return
        settled = true; stagesSettled++; stages.delete(key)
      })
      try {
        const result = Reflect.apply(original, this, args)
        safe(() => { if (result?.then) void result.then(finish, finish); else finish() })
        return result
      } catch (error) { finish(); throw error }
    }
    let replacement: unknown = wrapper
    if (typeof hook !== 'function') {
      const descriptors = Object.getOwnPropertyDescriptors(hook), handler = descriptors.handler
      descriptors.handler = {value: wrapper, enumerable: handler?.enumerable ?? true,
        configurable: handler?.configurable ?? true, writable: 'writable' in (handler ?? {}) ? handler!.writable : true}
      replacement = Object.create(Object.getPrototypeOf(hook), descriptors)
    }
    plugin.resolveId = replacement
    restores.push(() => {
      if (plugin.resolveId !== replacement) return
      if (descriptor) Object.defineProperty(plugin, 'resolveId', descriptor)
      else Reflect.deleteProperty(plugin, 'resolveId')
    })
  }
  const request = (req: {method?: string; url?: string}, res: Emitter & {statusCode?: number}) => safe(() => {
    const key = ++id, row = {kind: 'http-start', id: key, method: req.method, pathname: pathname(req.url)}
    remember(http, key, row); record(row)
    let ended = false
    const cleanup = () => { res.off('finish', finished); res.off('close', closed); cleanups.delete(cleanup) }
    const end = (kind: string) => safe(() => {
      // An earlier finish listener can emit close before this finish callback runs.
      if (ended) return
      ended = true
      const before = http.get(key)
      http.delete(key); cleanup()
      record({kind, id: key, status: res.statusCode, waitMs: before ? at() - Number(before.elapsedMs) : undefined})
    })
    const finished = () => end('http-finish'), closed = () => end('http-close')
    // An untracked request still has start metadata, avoid unbounded listeners.
    if (http.has(key)) { cleanups.add(cleanup); res.once('finish', finished); res.once('close', closed) }
  })
  server.httpServer?.prependListener('request', request)
  for (const [name, environment] of Object.entries(server.environments)) {
    if (innerStages) {
      for (const plugin of environment.pluginContainer?.plugins ?? []) wrapResolver(plugin)
      for (const method of ['resolveId', 'load', 'transform'])
        wrapStage(environment.pluginContainer, method, name, method === 'transform' ? 1 : 0)
      for (const method of ['getModuleByUrl', '_ensureEntryFromUrl'])
        wrapStage(environment.moduleGraph, method, name, 0)
    }
    const original = environment.transformRequest
    const descriptor = Object.getOwnPropertyDescriptor(environment, 'transformRequest')
    const wrapper = function(this: Environment, ...args: any[]) {
      const key = ++id, row = {kind: 'transform-start', id: key, environment: name, pathname: pathname(args[0])}
      safe(() => { remember(transforms, key, row); record(row) })
      const finish = (ok: boolean) => safe(() => {
        const before = transforms.get(key); transforms.delete(key)
        record({kind: 'transform-end', id: key, ok, waitMs: before ? at() - Number(before.elapsedMs) : undefined})
      })
      try {
        const result = Reflect.apply(original, this, args)
        // Observe settlement, return the original promise to Vite unchanged.
        safe(() => { void result.then(() => finish(true), () => finish(false)) })
        return result
      } catch (error) { finish(false); throw error }
    }
    environment.transformRequest = wrapper
    restores.push(() => {
      if (environment.transformRequest !== wrapper) return
      if (descriptor) Object.defineProperty(environment, 'transformRequest', descriptor)
      else Reflect.deleteProperty(environment, 'transformRequest')
    })
  }
  return {
    snapshot(scope: string) {
      record({kind: 'snapshot', scope, dropped, pendingDropped, http: [...http.values()], transforms: [...transforms.values()],
        ...(innerStages || callbackStages ? {stages: [...stages.values()], stagesStarted, stagesSettled} : {}),
        ...(callbackStages ? {callbacksStarted, callbacksSettled, callbackTailDropped, callbackTail: [...callbackTail]} : {})}, true)
    },
    dispose() {
      if (disposed) return
      disposed = true
      server.httpServer?.off('request', request)
      for (const cleanup of cleanups) safe(cleanup)
      for (const restore of restores) safe(restore)
      http.clear(); transforms.clear(); stages.clear(); callbackTail.length = 0
    },
  }
}
