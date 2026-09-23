/// <reference lib="webworker" />

import type {
  HostToRuntimeMessage,
  RuntimeHost,
  RuntimeToHostMessage,
} from './protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope
// This legacy native-JS backend has no controllable microtask checkpoint.
Object.defineProperty(globalThis,Symbol.for('web-container:task-queue'),{value:{
  mode:'approximate-microtask',
  nextTick(callback:(...args:unknown[])=>unknown,...args:unknown[]){if(typeof callback!=='function')throw new TypeError('Expected callback');queueMicrotask(()=>callback(...args))},
  task:(callback:(...args:unknown[])=>unknown,receiver:unknown,args:unknown[]=[])=>Reflect.apply(callback,receiver,args),
}})
const encoder = new TextEncoder()
const decoder = new TextDecoder()
let handler: ((request: Request) => Response | Promise<Response>) | undefined
let activeModuleUrl: string | undefined
let operationQueue = Promise.resolve()

function normalizePath(input: string | URL): string {
  const value = input instanceof URL ? input.pathname : input
  const parts: string[] = []
  for (const part of (value.startsWith('/') ? value : `/${value}`).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function errorMessage(id: number, error: unknown): RuntimeToHostMessage {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return { type: 'error', id, message: normalized.message, stack: normalized.stack }
}

async function loadRuntime(message: Extract<HostToRuntimeMessage, { type: 'load' }>) {
  handler = undefined
  const files = new Map(Object.entries(message.files))
  const retainedStores = new Map<{ _store: unknown }, unknown>()
  let requestActive = false
  const stat=async(path:string|URL)=>{
    const normalized=normalizePath(path),contents=files.get(normalized)
    const directory=normalized==='/'||[...files.keys()].some(file=>file.startsWith(`${normalized}/`))
    if(contents===undefined&&!directory)throw new Error(`ENOENT: no such file or directory, stat '${normalized}'`)
    return {
      kind:contents===undefined?'directory' as const:'file' as const,
      isDirectory:()=>directory&&contents===undefined,
      isFile:()=>contents!==undefined,
      size:contents===undefined?0:encoder.encode(contents).byteLength,
    }
  }
  const host: RuntimeHost = {
    asyncContext: {
      beginRequest() {
        requestActive = true
      },
      endRequest() {
        for (const [storage, previous] of retainedStores) storage._store = previous
        retainedStores.clear()
        requestActive = false
      },
      retain(storage, previous) {
        if (!requestActive || retainedStores.has(storage)) return false
        retainedStores.set(storage, previous)
        return true
      },
    },
    env: { ...message.env },
    fs: {
      async readFile(path, options) {
        const normalized = normalizePath(path)
        const contents = files.get(normalized)
        if (contents === undefined) throw new Error(`ENOENT: no such file, open '${normalized}'`)
        const encoding = typeof options === 'string' ? options : options?.encoding
        return encoding ? contents : encoder.encode(contents)
      },
      async readdir(path) {
        const normalized = normalizePath(path)
        const prefix = normalized === '/' ? '/' : `${normalized}/`
        return [...new Set(
          [...files.keys()]
            .filter((file) => file.startsWith(prefix))
            .map((file) => file.slice(prefix.length).split('/')[0])
            .filter(Boolean),
        )].sort()
      },
      stat,
      lstat:stat,
      async writeFile(path, contents) {
        files.set(normalizePath(path), typeof contents === 'string' ? contents : decoder.decode(contents))
      },
    },
  }

  globalThis.__webContainerHost = host

  if (activeModuleUrl) URL.revokeObjectURL(activeModuleUrl)
  activeModuleUrl = URL.createObjectURL(new Blob([message.code], { type: 'text/javascript' }))
  const runtimeModule = await import(/* @vite-ignore */ activeModuleUrl)
  const exportedHandler = runtimeModule.default?.fetch ?? runtimeModule.fetch ?? runtimeModule.default
  if (typeof exportedHandler !== 'function') {
    throw new Error('The entry module must export a fetch function or a default object with fetch(request)')
  }
  handler = exportedHandler.bind(runtimeModule.default)
}

async function runRequest(message: Extract<HostToRuntimeMessage, { type: 'request' }>) {
  if (!handler) throw new Error('Runtime has not loaded an entry module')
  const asyncContext = globalThis.__webContainerHost.asyncContext
  asyncContext.beginRequest()
  try {
    const { body, headers, method, url } = message.request
    const request = new Request(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    })
    const response = await handler(request)
    if (!(response instanceof Response)) throw new Error('The request handler must return a Response')

    scope.postMessage({
      type: 'response-start',
      id: message.id,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
    } satisfies RuntimeToHostMessage)

    if (response.body) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        scope.postMessage(
          { type: 'response-chunk', id: message.id, chunk } satisfies RuntimeToHostMessage,
          [chunk],
        )
      }
    }
    scope.postMessage({ type: 'response-end', id: message.id } satisfies RuntimeToHostMessage)
  } finally {
    asyncContext.endRequest()
  }
}

async function handleMessage(message: HostToRuntimeMessage) {
  try {
    if (message.type === 'load') {
      await loadRuntime(message)
      scope.postMessage({ type: 'loaded', id: message.id } satisfies RuntimeToHostMessage)
    } else {
      await runRequest(message)
    }
  } catch (error) {
    scope.postMessage(errorMessage(message.id, error))
  }
}

scope.onmessage = (event: MessageEvent<HostToRuntimeMessage>) => {
  const message = event.data
  operationQueue = operationQueue.then(() => handleMessage(message))
}
