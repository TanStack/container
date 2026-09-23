import './ui/styles.css'
import { compileProject } from './compiler/compile'
import { createProjectFileSystem } from './fs/create'
import { snapshotFileSystem } from './fs/types'
import { BrowserRuntime } from './runtime/client'
import { buildStartFixtureInBrowser } from './start-fixture/browser-build'
import { loadBrowserViteEngine } from './vite-browser/client'

const defaultSource = `import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import process from 'node:process'

const greeting = await readFile('/data/greeting.txt', 'utf8')
const requestContext = new AsyncLocalStorage<string>()

export default {
  async fetch(request: Request) {
    const url = new URL(request.url)
    const name = url.pathname.split('/').filter(Boolean).at(-1) ?? 'browser'
    const routeFile = path.join('/routes', url.pathname, 'index.tsx')

    return requestContext.run(name, async () => {
      await Promise.resolve()

      const body = [
        \`\${greeting}, \${name}!\`,
        \`route: \${routeFile}\`,
        \`runtime: \${process.release.name}\`,
        \`context: \${requestContext.getStore()}\`,
      ].join('\\n')

      return new Response(body, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    })
  },
}
`

const source = document.querySelector<HTMLTextAreaElement>('#source')!
const status = document.querySelector<HTMLOutputElement>('#status')!
const timing = document.querySelector<HTMLOutputElement>('#timing')!
const responseOutput = document.querySelector<HTMLPreElement>('#response')!
let preview = document.querySelector<HTMLIFrameElement>('#preview')!
const pathInput = document.querySelector<HTMLInputElement>('#request-path')!
const compileButton = document.querySelector<HTMLButtonElement>('#compile')!
const viteSmokeButton = document.querySelector<HTMLButtonElement>('#vite-smoke')!
const loadStartButton = document.querySelector<HTMLButtonElement>('#load-start')!
const requestButton = document.querySelector<HTMLButtonElement>('#request')!
const requestForm = document.querySelector<HTMLFormElement>('#request-form')!

const fs = await createProjectFileSystem()
const runtime = new BrowserRuntime()

async function runViteSmoke() {
  const engine = await loadBrowserViteEngine()
  return engine.runBrowserViteSmokeBuild({
    '/app/package.json': '{"type":"module"}',
    '/app/src/main.ts': 'export const answer: number = 42',
  })
}

declare global {
  interface Window {
    __webContainerSpike?: {
      runtime: BrowserRuntime
      viteSmoke: () => Promise<unknown>
    }
  }
}

if (import.meta.env.DEV) {
  window.__webContainerSpike = {
    runtime,
    viteSmoke: runViteSmoke,
  }
  document.addEventListener('web-container:vite-smoke', () => {
    void runViteSmoke().then(
      (result: { duration: number; files: Record<string, Uint8Array> }) => {
        document.documentElement.dataset.viteSmoke = JSON.stringify({
          duration: result.duration,
          files: Object.keys(result.files),
          output: new TextDecoder().decode(Object.values(result.files)[0]),
        })
      },
      (error: unknown) => {
        document.documentElement.dataset.viteSmoke = JSON.stringify({
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        })
      },
    )
  })
}

function setStatus(message: string, state: 'loading' | 'ready' | 'error') {
  status.textContent = message
  status.dataset.state = state
}

function setBusy(busy: boolean) {
  compileButton.disabled = busy
  viteSmokeButton.disabled = busy
  loadStartButton.disabled = busy
  requestButton.disabled = busy
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (!error.stack) return error.message
  return error.stack.includes(error.message)
    ? error.stack
    : `${error.message}\n${error.stack}`
}

function showTextResponse(text: string) {
  preview.hidden = true
  preview.removeAttribute('srcdoc')
  responseOutput.hidden = false
  responseOutput.textContent = text
}

function showHtmlResponse(html: string) {
  // This is a static SSR viewer. Build-output URLs are not served by the host app.
  const documentCopy = new DOMParser().parseFromString(html, 'text/html')
  documentCopy.querySelectorAll('script, link[rel~="modulepreload"], link[rel~="preload"]').forEach(element => element.remove())
  responseOutput.hidden = true
  const nextPreview = document.createElement('iframe')
  nextPreview.id = 'preview'
  nextPreview.title = 'Rendered server response'
  nextPreview.setAttribute('sandbox', '')
  nextPreview.srcdoc = documentCopy.documentElement.outerHTML
  preview.replaceWith(nextPreview)
  preview = nextPreview
}

async function ensureProject() {
  if (!(await fs.exists('/src/server.ts'))) {
    await fs.writeText('/src/server.ts', defaultSource)
  } else {
    const existingSource = await fs.readText('/src/server.ts')
    const isPreviousDemo =
      existingSource.includes("const greeting = await readFile('/data/greeting.txt', 'utf8')") &&
      existingSource.includes('runtime: ${process.release.name}') &&
      !existingSource.includes("from 'node:async_hooks'")
    if (isPreviousDemo) await fs.writeText('/src/server.ts', defaultSource)
  }
  if (!(await fs.exists('/data/greeting.txt'))) {
    await fs.writeText('/data/greeting.txt', 'Hello')
  }
  source.value = await fs.readText('/src/server.ts')
}

async function compileAndLoad() {
  const started = performance.now()
  setBusy(true)
  setStatus('Compiling…', 'loading')
  try {
    await fs.writeText('/src/server.ts', source.value)
    const result = await compileProject(fs)
    await runtime.load(result.code, await snapshotFileSystem(fs), {
      NODE_ENV: 'development',
    })
    timing.textContent = `${Math.round(performance.now() - started)} ms compile + load`
    setStatus('Ready', 'ready')
  } catch (error) {
    setStatus('Compile failed', 'error')
    showTextResponse(describeError(error))
  } finally {
    setBusy(false)
  }
}

async function loadStartFixture() {
  const started = performance.now()
  setBusy(true)
  setStatus('Loading Start…', 'loading')
  try {
    const build = await buildStartFixtureInBrowser((message) => {
      setStatus(message, 'loading')
    })
    await runtime.load(build.code, {}, {
      NODE_ENV: 'production',
      TSS_DEV_SERVER: 'false',
      TSS_PRERENDERING: 'false',
      TSS_SHELL: 'false',
    })
    pathInput.value = '/'
    showTextResponse('TanStack Start is ready. Send a request to render it.')
    timing.textContent = `${build.packageCount} packages · ${build.outputFileCount} outputs · ${Math.round(build.viteDuration)} ms Vite · ${Math.round(performance.now() - started)} ms total`
    setStatus('Start ready', 'ready')
  } catch (error) {
    setStatus('Start load failed', 'error')
    showTextResponse(describeError(error))
  } finally {
    setBusy(false)
  }
}

async function runViteSmokeFromUi() {
  setBusy(true)
  setStatus('Running Vite in browser…', 'loading')
  try {
    const result = await runViteSmoke() as {
      duration: number
      files: Record<string, Uint8Array>
    }
    const [file, contents] = Object.entries(result.files)[0] ?? []
    if (!file || !contents) throw new Error('Vite produced no output')
    showTextResponse(`${file}\n\n${new TextDecoder().decode(contents)}`)
    timing.textContent = `${Math.round(result.duration)} ms browser Vite build`
    setStatus('Vite ready', 'ready')
  } catch (error) {
    setStatus('Vite build failed', 'error')
    showTextResponse(describeError(error))
  } finally {
    setBusy(false)
  }
}

async function sendRequest() {
  const started = performance.now()
  setBusy(true)
  setStatus('Running request…', 'loading')
  try {
    const requestPath = pathInput.value.startsWith('/') ? pathInput.value : `/${pathInput.value}`
    const response = await runtime.fetch(`https://runtime.local${requestPath}`)
    const body = await response.text()
    if (response.headers.get('content-type')?.includes('text/html')) {
      showHtmlResponse(body)
    } else {
      showTextResponse(body)
    }
    timing.textContent = `${response.status} · ${Math.round(performance.now() - started)} ms`
    setStatus('Ready', 'ready')
  } catch (error) {
    setStatus('Request failed', 'error')
    showTextResponse(describeError(error))
  } finally {
    setBusy(false)
  }
}

compileButton.addEventListener('click', () => void compileAndLoad())
viteSmokeButton.addEventListener('click', () => void runViteSmokeFromUi())
loadStartButton.addEventListener('click', () => void loadStartFixture())
requestForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void sendRequest()
})

try {
  await ensureProject()
  await compileAndLoad()
} catch (error) {
  setStatus('Startup failed', 'error')
  showTextResponse(describeError(error))
}
