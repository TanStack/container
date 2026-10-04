import * as React from 'react'
import * as v from 'valibot'
import { BrowserIcon, FolderOpenIcon, PlayIcon, TerminalWindowIcon } from '@phosphor-icons/react'
import { NativeOwnerClient, URLPreview } from '@tanstack/browser-sandbox-experimental'
import { ButtonGroup } from '~/components/ButtonGroup'
import { FileExplorer, type FileExplorerNode } from '~/components/FileExplorer'
import { useTheme } from '~/components/ThemeProvider'
import { Button } from '~/components/ds/ui'
import { Tooltip } from '~/ui'
import type { ExampleDefinition } from '~/utils/example-workspace'
import { CodeMirrorEditor } from './CodeMirrorEditor.client'
import { SandboxBrowser } from './SandboxBrowser.client'
import { WebContainerProcessTerminalPanel } from './WebContainerTerminal.client'
import { NativeTerminal } from './NativeTerminal.client'

const projectSchema = v.object({
  files: v.record(v.string(), v.string()),
  binaryFiles: v.record(v.string(), v.string()),
  identity: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
})
type Project = v.InferOutput<typeof projectSchema>
type Preview = Awaited<ReturnType<typeof URLPreview.mount>>
const workbenchViews: Array<'preview' | 'code' | 'output'> = ['preview', 'code', 'output']
const ownerOrigin = import.meta.env.VITE_NATIVE_OWNER_ORIGIN || 'http://127.0.0.1:4197'
const previewOrigin = import.meta.env.VITE_NATIVE_PREVIEW_ORIGIN || 'http://127.0.0.1:4199'

function decode(project: Project) {
  const files: Record<string, string | Uint8Array> = { ...project.files }
  for (const [path, value] of Object.entries(project.binaryFiles)) {
    files[path] = Uint8Array.from(atob(value), character => character.charCodeAt(0))
  }
  return files
}

function createFileTree(paths: string[]) {
  const root: FileExplorerNode[] = []
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean)
    let children = root
    for (const [index, name] of parts.entries()) {
      const nodePath = '/' + parts.slice(0, index + 1).join('/')
      const last = index === parts.length - 1
      let node = children.find(candidate => candidate.path === nodePath)
      if (!node) {
        node = { children: last ? undefined : [], depth: index, name, path: nodePath, type: last ? 'file' : 'dir' }
        children.push(node)
      }
      if (node.children) children = node.children
    }
  }
  return root
}

export function ExampleNativeWorkbench({ definition, exampleId }: {
  definition: ExampleDefinition
  exampleId: string
}) {
  const { resolvedTheme } = useTheme()
  const initialPath = '/' + (definition.initialFile ?? definition.workspace.entry).replace(/^\//, '')
  const [files, setFiles] = React.useState<Record<string, string | Uint8Array> | null>(null)
  const [loadedFor, setLoadedFor] = React.useState('')
  const [activePath, setActivePath] = React.useState(initialPath)
  const [showFiles, setShowFiles] = React.useState(true)
  const [installProgress, setInstallProgress] = React.useState<number | null>(null)
  const [output, setOutput] = React.useState('')
  const [outputGeneration, setOutputGeneration] = React.useState(0)
  const [showOutput, setShowOutput] = React.useState(false)
  const [consoleTab, setConsoleTab] = React.useState<'terminal' | 'output'>('terminal')
  const [showPreview, setShowPreview] = React.useState(true)
  const [mobileView, setMobileView] = React.useState<'preview' | 'code' | 'output'>('preview')
  const [codePanelPercent, setCodePanelPercent] = React.useState(50)
  const [terminalPanelPercent, setTerminalPanelPercent] = React.useState(42)
  const [previewUrl, setPreviewUrl] = React.useState(previewOrigin + '/')
  const [running, setRunning] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const ownerRef = React.useRef<HTMLIFrameElement>(null)
  const previewRef = React.useRef<HTMLDivElement>(null)
  const clientRef = React.useRef<NativeOwnerClient | null>(null)
  const terminalSessionRef = React.useRef<Awaited<ReturnType<NativeOwnerClient['openTerminalSession']>> | null>(null)
  const terminalFocusRef = React.useRef<{ focus(): void } | null>(null)
  const previewSessionRef = React.useRef<Preview | null>(null)
  const pendingWritesRef = React.useRef(new Map<string, string>())
  const writeTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const writingRef = React.useRef<Promise<void>>(Promise.resolve())
  const autoStartedRef = React.useRef('')
  const splitRef = React.useRef<HTMLDivElement>(null)
  const previewPanelRef = React.useRef<HTMLElement>(null)
  const resizeRef = React.useRef<{ pointerId: number; previousCursor: string; previousUserSelect: string } | null>(null)
  const terminalResizeRef = React.useRef<{ pointerId: number; previousCursor: string; previousUserSelect: string } | null>(null)
  const relativePaths = React.useMemo(() => files
    ? Object.keys(files).filter(path => path.startsWith('/project/')).map(path => path.slice('/project'.length)).sort()
    : [], [files])
  const tree = React.useMemo(() => createFileTree(relativePaths), [relativePaths])
  const activeSource = files?.['/project' + activePath]

  React.useEffect(() => {
    const controller = new AbortController()
    setFiles(null)
    setLoadedFor('')
    setActivePath(initialPath)
    setError('')
    void fetch('/__native-local/project.json?example=' + encodeURIComponent(exampleId), {
      signal: controller.signal, cache: 'no-store',
    }).then(async response => {
      if (!response.ok) throw Error('Could not load the local example (' + response.status + ')')
      return v.parse(projectSchema, await response.json())
    }).then(project => {
      if (controller.signal.aborted) return
      if (!/^[a-f0-9]{64}$/.test(project.identity)) throw Error('Example identity is invalid')
      const decoded = decode(project)
      if (typeof decoded['/project' + initialPath] !== 'string') throw Error('Example entry file is missing')
      setFiles(decoded)
      setLoadedFor(exampleId)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(String(cause))
    })
    return () => {
      controller.abort()
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
      previewSessionRef.current?.close()
      previewSessionRef.current = null
      const client = clientRef.current
      clientRef.current = null
      terminalSessionRef.current = null
      if (client) void client.dispose().catch(() => undefined).finally(() => client.close())
    }
  }, [exampleId, initialPath])

  React.useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      const preview = previewSessionRef.current
      if (!preview) return
      void preview.inspect().then(state => setPreviewUrl(state.url)).catch(() => undefined)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [running])

  function flushWrites() {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    writeTimerRef.current = undefined
    const client = clientRef.current
    if (!client) return writingRef.current
    writingRef.current = writingRef.current.then(async () => {
      for (const [path, value] of pendingWritesRef.current) {
        await client.writeFile(path, value)
        if (pendingWritesRef.current.get(path) === value) pendingWritesRef.current.delete(path)
      }
    })
    return writingRef.current
  }

  function updateSource(value: string) {
    const path = '/project' + activePath
    setFiles(current => current ? { ...current, [path]: value } : current)
    if (!clientRef.current || !running) return
    pendingWritesRef.current.set(path, value)
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    writeTimerRef.current = setTimeout(() => { void flushWrites().catch(cause => setError(String(cause))) }, 150)
  }

  async function selectFile(path: string) {
    if (!files) return
    try {
      await flushWrites()
      const client = clientRef.current
      if (client && running && typeof files['/project' + path] === 'string') {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(await client.readFile('/project' + path))
        setFiles(current => current ? { ...current, ['/project' + path]: value } : current)
      }
      setActivePath(path)
    } catch (cause) { setError(String(cause)) }
  }

  async function runTerminalCommand(line: string, cwd: string, onOutput: (text: string) => void, signal?: AbortSignal,
    onControl?: (control: Pick<ReturnType<NativeOwnerClient['openTerminalCommand']>, 'writeInput' | 'endInput' | 'interrupt' | 'resize'>) => void,
    size?: { columns: number; rows: number }) {
    const client = clientRef.current
    if (!client || !running) throw Error('The example is still starting')
    await flushWrites()
    terminalSessionRef.current ??= await client.openTerminalSession(cwd)
    const session = terminalSessionRef.current.runCommand(line, onOutput, size)
    const abort = () => session.interrupt()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    onControl?.(session)
    let result: Awaited<ReturnType<NativeOwnerClient['terminalCommand']>>
    try { result = await session.result }
    finally { signal?.removeEventListener('abort', abort) }
    for (const path of result.changedPaths) {
      if (!path.startsWith('/project/')) continue
      try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(await client.readFile(path))
        setFiles(current => current ? { ...current, [path]: value } : current)
      } catch {
        setFiles(current => {
          if (!current || !Object.hasOwn(current, path)) return current
          const next = { ...current }
          delete next[path]
          return next
        })
      }
    }
    // Vite owns module updates. Data files and unrelated paths must not
    // restart the preview document or interrupt its hydration.
    return result
  }

  function closeRuntime() {
    previewSessionRef.current?.close()
    previewSessionRef.current = null
    const client = clientRef.current
    clientRef.current = null
    terminalSessionRef.current = null
    if (!client) return Promise.resolve()
    return client.dispose().finally(() => client.close())
  }

  async function loadOwner() {
    const frame = ownerRef.current
    if (!frame) throw Error('Native owner frame is missing')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { window.removeEventListener('message', listener); reject(Error('Native owner frame did not load')) }, 10000)
      const listener = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.origin !== ownerOrigin || event.data !== 'native-owner-ready') return
        clearTimeout(timeout)
        window.removeEventListener('message', listener)
        resolve()
      }
      window.addEventListener('message', listener)
      frame.src = ownerOrigin + '/owner.html'
    })
    if (!frame.contentWindow) throw Error('Native owner frame is unavailable')
    return NativeOwnerClient.connect(frame.contentWindow, ownerOrigin, previewOrigin, {
      expectedBuildId: import.meta.env.VITE_NATIVE_SDK_BUILD_ID,
    })
  }

  async function run() {
    if (!files || busy || !previewRef.current) return
    setBusy(true)
    setError('')
    setOutput('')
    setInstallProgress(null)
    setOutputGeneration(value => value + 1)
    try {
      if (clientRef.current) {
        await flushWrites()
        await closeRuntime()
        setRunning(false)
      }
      const client = await loadOwner()
      clientRef.current = client
      client.subscribeEvents(event => {
        if (event.type === 'progress') {
          const installed = /^dependency-installed:(\d+)\/(\d+)$/.exec(event.phase)
          setInstallProgress(installed && Number(installed[2]) > 0
            ? Math.min(1, Number(installed[1]) / Number(installed[2])) : null)
        }
        if (event.type === 'output') setOutput(previous => (previous + event.text).slice(-64000))
        if (event.type === 'diagnostic') setError(event.error)
      })
      const options = {
        workspaceRoot: '/project', installCommand: 'pnpm install', startCommand: 'pnpm run dev',
        ...(exampleId === 'basic-ssr-file-based' ? { previewPort: 3000 } : {}),
      }
      await client.start(files, options)
      previewSessionRef.current = await URLPreview.mount(previewRef.current, {
        origin: previewOrigin,
        server: { fetch: request => client.fetch(request), revision: () => client.workspaceRevision() },
        connectWebSocket: (url, protocols) => client.connectWebSocket(previewOrigin, url, protocols),
        ...(exampleId === 'basic-ssr-file-based' ? {
          scriptOrigins: ['https://unpkg.com'], connectOrigins: ['https://jsonplaceholder.typicode.com'],
        } : {}),
      })
      setRunning(true)
      setPreviewUrl(previewOrigin + '/')
    } catch (cause) {
      setError(String(cause))
      await closeRuntime().catch(cleanup => setError(previous => previous + '\nCleanup failed: ' + String(cleanup)))
    } finally { setBusy(false) }
  }

  React.useEffect(() => {
    if (!files || loadedFor !== exampleId || autoStartedRef.current === exampleId) return
    autoStartedRef.current = exampleId
    void run()
  }, [exampleId, files, loadedFor])

  function resize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !splitRef.current) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = {
      pointerId: event.pointerId,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  function moveResize(event: React.PointerEvent<HTMLDivElement>) {
    if (resizeRef.current?.pointerId !== event.pointerId || !splitRef.current) return
    const rect = splitRef.current.getBoundingClientRect()
    setCodePanelPercent(Math.max(25, Math.min(75, ((event.clientX - rect.left) / rect.width) * 100)))
  }

  function finishResize(event: React.PointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    document.body.style.cursor = resize.previousCursor
    document.body.style.userSelect = resize.previousUserSelect
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function startTerminalResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !previewPanelRef.current) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    terminalResizeRef.current = {
      pointerId: event.pointerId,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  function moveTerminalResize(event: React.PointerEvent<HTMLDivElement>) {
    if (terminalResizeRef.current?.pointerId !== event.pointerId || !previewPanelRef.current) return
    const rect = previewPanelRef.current.getBoundingClientRect()
    setTerminalPanelPercent(Math.max(18, Math.min(70, ((rect.bottom - event.clientY) / rect.height) * 100)))
  }

  function finishTerminalResize(event: React.PointerEvent<HTMLDivElement>) {
    const resize = terminalResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    document.body.style.cursor = resize.previousCursor
    document.body.style.userSelect = resize.previousUserSelect
    terminalResizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function navigatePreview(value: string) {
    const preview = previewSessionRef.current
    if (!preview) return
    try {
      const target = new URL(value, previewUrl)
      if (target.origin !== previewOrigin) throw Error('Preview navigation must stay in this workspace')
      preview.navigate(target.pathname + target.search + target.hash)
      setPreviewUrl(target.href)
    } catch (cause) { setError(String(cause)) }
  }

  const bootOverlayVisible = !running || busy
  const showRightPanel = showPreview || showOutput

  return <section data-native-preview-ready={!bootOverlayVisible} className="sandbox-ui not-prose relative flex h-[clamp(520px,75dvh,720px)] min-w-0 flex-col overflow-hidden rounded-lg border border-border-default bg-background-default text-text-primary" aria-label={`${definition.title} workbench`}>
    <header className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-border-default px-2">
      <div className={`${mobileView === 'code' ? 'flex' : 'hidden'} min-w-0 items-center gap-2 lg:flex`}>
        <Tooltip content={showFiles ? 'Hide files' : 'Show files'} side="bottom">
          <Button type="button" variant="icon" color="gray" size="icon-sm" rounded="md" aria-pressed={showFiles} aria-label={showFiles ? 'Hide files' : 'Show files'} onClick={() => setShowFiles(value => !value)}>
            <FolderOpenIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </Tooltip>
        <span className="min-w-0 truncate font-ds-mono text-xs text-text-muted">{activePath}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ButtonGroup>
          <Button type="button" variant="ghost" size="xs" rounded="none" aria-label={showOutput ? 'Hide terminal' : 'Show terminal'} aria-pressed={showOutput} onClick={() => setShowOutput(value => !value)}>
            <TerminalWindowIcon className="size-3.5" aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="xs" rounded="none" className="hidden lg:inline-flex" aria-label={showPreview ? 'Hide preview' : 'Show preview'} aria-pressed={showPreview} onClick={() => setShowPreview(value => !value)}>
            <BrowserIcon className="size-3.5" aria-hidden="true" /><span>Preview</span>
          </Button>
          <Tooltip content="Run" side="bottom">
            <Button type="button" variant="primary" size="xs" rounded="none" aria-label="Run" onClick={() => void run()} disabled={!files || busy}>
              <PlayIcon className="size-3.5" aria-hidden="true" />
            </Button>
          </Tooltip>
        </ButtonGroup>
      </div>
    </header>
    <div className="shrink-0 border-b border-border-default p-1 lg:hidden">
      <ButtonGroup role="group" aria-label="Workbench view" className="flex w-full shadow-none">
        {workbenchViews.map(view => <Button key={view} type="button" variant="ghost" size="xs" rounded="none" className="flex-1 justify-center capitalize" aria-pressed={mobileView === view} onClick={() => { setMobileView(view); if (view === 'output') setShowOutput(true) }}>{view === 'output' ? 'Console' : view}</Button>)}
      </ButtonGroup>
    </div>
    <div ref={splitRef} className="flex min-h-0 min-w-0 flex-1">
      <section style={{ flexGrow: showRightPanel ? codePanelPercent : 100 }} className={`${mobileView === 'code' ? 'flex' : 'hidden'} min-h-0 min-w-0 basis-0 flex-col overflow-hidden lg:flex`}>
        <div className="flex min-h-0 flex-1">
          <FileExplorer currentPath={activePath} files={tree} isSidebarOpen={showFiles} libraryColor="bg-emerald-500" onSidebarClose={() => setShowFiles(false)} prefetchFileContent={() => {}} setCurrentPath={path => void selectFile(path)} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--th-background)]">
            <div aria-hidden={showFiles} inert={showFiles} className={`${showFiles ? 'hidden' : 'flex'} fade-x h-9 shrink-0 overflow-x-auto border-b border-border-default bg-background-subtle`}>
              {relativePaths.map(path => <button key={path} type="button" title={path} onClick={() => void selectFile(path)} className={`shrink-0 border-r border-border-default px-2 font-ds-mono text-[11px] ${activePath === path ? 'bg-background-default text-text-primary' : 'text-text-muted hover:bg-background-elevated hover:text-text-secondary'}`}>{path.split('/').pop()}</button>)}
            </div>
            <div className="min-h-0 flex-1">
              {typeof activeSource === 'string'
                ? <CodeMirrorEditor path={activePath} theme={resolvedTheme} value={activeSource} onChange={updateSource} onRun={() => void run()} />
                : <p className="p-3 text-sm text-text-muted">This file is binary.</p>}
            </div>
          </div>
        </div>
      </section>
      <div role="separator" aria-label={showPreview ? 'Resize code and preview panels' : 'Resize code and terminal panels'} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(codePanelPercent)} tabIndex={showRightPanel ? 0 : -1} title="Drag to resize. Double-click to reset." onPointerDown={resize} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize} onDoubleClick={() => setCodePanelPercent(50)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setCodePanelPercent(value => Math.max(25, Math.min(75, value + (event.key === 'ArrowRight' ? 2 : -2)))) } }} className={`${showRightPanel ? 'lg:flex' : 'lg:hidden'} group relative hidden w-2 shrink-0 touch-none cursor-col-resize items-center justify-center bg-background-default hover:bg-blue-500/15 focus-visible:outline-2 focus-visible:outline-blue-500`}>
        <div className="h-full w-px bg-border-default group-hover:bg-blue-400" />
      </div>
      <section ref={previewPanelRef} style={{ flexGrow: showRightPanel ? 100 - codePanelPercent : 0 }} className={`${mobileView === 'code' ? 'hidden' : 'flex'} min-h-0 min-w-0 basis-0 flex-col overflow-hidden ${showRightPanel ? 'lg:flex' : 'lg:hidden'}`}>
        <div className={`${mobileView === 'output' ? 'hidden' : 'block'} ${showPreview ? 'lg:block' : 'lg:hidden'} relative min-h-0 flex-1`}>
          <div className="size-full" inert={bootOverlayVisible} aria-hidden={bootOverlayVisible}>
            <SandboxBrowser currentUrl={previewUrl} history={[previewUrl]} navigationAvailable={running} canGoBack={false} canGoForward={false} onBack={() => {}} onForward={() => {}} onNavigate={navigatePreview} onReload={() => navigatePreview(previewUrl)}>
              <div ref={previewRef} aria-label={`${definition.title} preview`} className="size-full bg-white [&>iframe]:block [&>iframe]:size-full [&>iframe]:border-0" />
            </SandboxBrowser>
          </div>
          {bootOverlayVisible && <div data-native-boot-overlay="" className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background-default">
            <div className="flex shrink-0 flex-col items-center gap-4 px-5 py-7">
              <div className="relative size-16 text-text-primary" aria-hidden="true">
                <svg viewBox="0 0 64 64" className="size-full -rotate-90">
                  <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="2" className="text-border-default" />
                  <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" pathLength="100" strokeDasharray={`${installProgress === null ? 24 : installProgress * 100} 100`} className={error ? 'hidden' : installProgress === null ? 'origin-center motion-safe:animate-spin' : 'transition-all duration-300 motion-reduce:transition-none'} />
                </svg>
                <TerminalWindowIcon className="absolute inset-0 m-auto size-6" />
              </div>
              <span role="status" className="max-w-full text-center text-xs text-text-secondary">{error ? 'Could not start example' : installProgress === null ? 'Starting environment...' : `Installing dependencies... ${Math.round(installProgress * 100)}%`}</span>
            </div>
            <div className="min-h-0 flex-1">
              <WebContainerProcessTerminalPanel active generation={outputGeneration} offset={0} output={output} theme={resolvedTheme} />
            </div>
            {error && <p role="alert" className="max-h-24 overflow-auto whitespace-pre-wrap border-t border-border-default p-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          </div>}
        </div>
        {showOutput && showPreview && <div role="separator" aria-label="Resize preview and terminal panels" aria-orientation="horizontal" aria-valuemin={18} aria-valuemax={70} aria-valuenow={Math.round(terminalPanelPercent)} tabIndex={0} title="Drag to resize. Double-click to reset." onPointerDown={startTerminalResize} onPointerMove={moveTerminalResize} onPointerUp={finishTerminalResize} onPointerCancel={finishTerminalResize} onLostPointerCapture={finishTerminalResize} onDoubleClick={() => setTerminalPanelPercent(42)} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setTerminalPanelPercent(value => Math.max(18, Math.min(70, value + (event.key === 'ArrowUp' ? 2 : -2)))) } }} className="hidden h-1.5 shrink-0 cursor-row-resize touch-none border-y border-border-default bg-background-subtle hover:bg-background-elevated focus-visible:outline-2 focus-visible:outline-blue-500 lg:block" />}
        <div style={{ height: mobileView === 'output' || !showPreview ? undefined : `${terminalPanelPercent}%` }} className={`${showOutput ? 'flex' : 'hidden'} ${mobileView === 'output' ? 'flex-1' : ''} min-h-0 flex-col bg-background-default ${showPreview ? 'lg:flex-none' : 'lg:flex-1'}`}>
          <div className="flex h-8 shrink-0 items-center gap-4 border-b border-border-default px-4 font-ds-mono text-[11px]">
            <button type="button" aria-pressed={consoleTab === 'terminal'} onClick={() => { setConsoleTab('terminal'); terminalFocusRef.current?.focus() }} className={consoleTab === 'terminal' ? 'text-text-primary' : 'text-text-muted'}>Terminal</button>
            <button type="button" aria-pressed={consoleTab === 'output'} onClick={() => setConsoleTab('output')} className={consoleTab === 'output' ? 'text-text-primary' : 'text-text-muted'}>Process</button>
          </div>
          <div className={`${consoleTab === 'output' ? 'hidden' : 'block'} min-h-0 flex-1`}>
            {running && <NativeTerminal focusRef={terminalFocusRef} active={showOutput && consoleTab === 'terminal'} generation={outputGeneration} onCommand={runTerminalCommand} onListCommands={async () => {
              const client = clientRef.current
              if (!client) throw Error('The example is not running')
              return client.listTerminalCommands()
            }} onListDirectory={async path => {
              const client = clientRef.current
              if (!client) throw Error('The example is not running')
              return client.listDirectory(path)
            }} theme={resolvedTheme} />}
          </div>
          <div className={`${consoleTab === 'terminal' ? 'hidden' : 'block'} min-h-0 flex-1`}><WebContainerProcessTerminalPanel active={showOutput && consoleTab === 'output'} generation={outputGeneration} offset={0} output={output} theme={resolvedTheme} /></div>
        </div>
      </section>
    </div>
    <iframe ref={ownerRef} title="Native sandbox owner" allow="cross-origin-isolated" className="absolute h-px w-px opacity-0" />
  </section>
}
