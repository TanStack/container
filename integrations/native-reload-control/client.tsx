import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { NativeOwnerClient, URLPreview } from '@control/sdk'
import { NativeTerminal } from '@control/terminal'
import { CodeMirrorEditor } from '@control/editor'

declare const __RELOAD_CONTROL__: { owner: string; preview: string; buildId: string; inspect: boolean }
type Client = NativeOwnerClient
type Preview = Awaited<ReturnType<typeof URLPreview.mount>>
const entry = '/project/src/routes/index.tsx'

function ReloadControl() {
  const ownerRef = React.useRef<HTMLIFrameElement>(null)
  const previewRef = React.useRef<HTMLDivElement>(null)
  const clientRef = React.useRef<Client | null>(null)
  const previewSessionRef = React.useRef<Preview | null>(null)
  const sessionRef = React.useRef<Awaited<ReturnType<Client['openTerminalSession']>> | null>(null)
  const focusRef = React.useRef<{ focus(): void } | null>(null)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState('')
  const [source, setSource] = React.useState('')
  const [showTerminal, setShowTerminal] = React.useState(false)
  const [height, setHeight] = React.useState(42)
  const [previewUrl, setPreviewUrl] = React.useState(__RELOAD_CONTROL__.preview + '/')
  const pending = React.useRef<string | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const writing = React.useRef(Promise.resolve())
  const inspections = React.useRef({ attempted: 0, succeeded: 0, failed: 0 })

  function flushWrites() {
    clearTimeout(timer.current)
    timer.current = undefined
    writing.current = writing.current.then(async () => {
      const value = pending.current
      if (value === null || !clientRef.current) return
      await clientRef.current.writeFile(entry, value)
      if (pending.current === value) pending.current = null
    })
    return writing.current
  }

  React.useEffect(() => {
    let disposed = false
    const frame = ownerRef.current!
    const container = previewRef.current!
    const start = async () => {
      const project = await fetch('/project.json').then(response => {
        if (!response.ok) throw Error('Pinned project unavailable')
        return response.json()
      })
      const files = Object.fromEntries(Object.entries(project.files).map(([path, bytes]) => [path,
        typeof bytes === 'string' ? bytes : new Uint8Array(bytes as number[])]))
      if (!files[entry]) throw Error('Counter entry missing')
      setSource(typeof files[entry] === 'string' ? files[entry] : new TextDecoder('utf-8', { fatal: true }).decode(files[entry]))
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { removeEventListener('message', listener); reject(Error('Owner frame timed out')) }, 10000)
        const listener = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow || event.origin !== __RELOAD_CONTROL__.owner || event.data !== 'native-owner-ready') return
          clearTimeout(timeout); removeEventListener('message', listener); resolve()
        }
        addEventListener('message', listener)
        frame.src = __RELOAD_CONTROL__.owner + '/owner.html'
      })
      const client = await NativeOwnerClient.connect(frame.contentWindow!, __RELOAD_CONTROL__.owner,
        __RELOAD_CONTROL__.preview, { expectedBuildId: __RELOAD_CONTROL__.buildId })
      clientRef.current = client
      await client.start(files, { workspaceRoot: '/project', installCommand: 'pnpm install', startCommand: 'pnpm run dev' })
      const preview = await URLPreview.mount(container, {
        origin: __RELOAD_CONTROL__.preview,
        server: { fetch: request => client.fetch(request), revision: () => client.workspaceRevision() },
        connectWebSocket: (url, protocols) => client.connectWebSocket(__RELOAD_CONTROL__.preview, url, protocols),
      })
      if (disposed) { preview.close(); await client.dispose(); client.close(); return }
      previewSessionRef.current = preview
      window.reloadControl = { flushWrites, inspections: inspections.current,
        readEntry: async () => new TextDecoder().decode(await client.readFile(entry)) }
      setReady(true)
    }
    void start().catch(cause => { if (!disposed) setError(String(cause)) })
    return () => {
      disposed = true
      clearTimeout(timer.current)
      previewSessionRef.current?.close()
      const client = clientRef.current
      clientRef.current = null
      if (client) void client.dispose().finally(() => client.close())
    }
  }, [])

  React.useEffect(() => {
    if (!ready || !__RELOAD_CONTROL__.inspect) return
    const interval = setInterval(() => {
      const preview = previewSessionRef.current
      if (preview) {
        inspections.current.attempted++
        void preview.inspect().then(state => { inspections.current.succeeded++; setPreviewUrl(state.url) })
          .catch(() => { inspections.current.failed++ })
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [ready])

  const onCommand: React.ComponentProps<typeof NativeTerminal>['onCommand'] = async (line, cwd, onOutput, signal, onControl, size) => {
    const client = clientRef.current
    if (!client || !ready) throw Error('Counter is still starting')
    await flushWrites()
    sessionRef.current ??= await client.openTerminalSession(cwd)
    const command = sessionRef.current.runCommand(line, onOutput, size)
    const abort = () => command.interrupt()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    onControl?.(command)
    try {
      const result = await command.result
      if (result.changedPaths.includes(entry)) setSource(new TextDecoder().decode(await client.readFile(entry)))
      return result
    } finally { signal?.removeEventListener('abort', abort) }
  }

  return <main data-ready={ready}>
    <header>
      <button onClick={() => setShowTerminal(value => !value)} disabled={!ready}>{showTerminal ? 'Hide terminal' : 'Show terminal'}</button>
      <button onClick={() => {
        const target = new URL(previewUrl)
        if (target.origin !== __RELOAD_CONTROL__.preview) { setError('Preview origin changed'); return }
        previewSessionRef.current?.navigate(target.pathname + target.search + target.hash)
      }} disabled={!ready}>Reload preview</button>
      {!ready && !error && <span role="status">Starting Counter...</span>}
      {error && <pre role="alert">{error}</pre>}
    </header>
    <div className="panels">
      <section className="editor">
        {source && <CodeMirrorEditor value={source} path="/src/routes/index.tsx" theme="light"
          onRun={() => { void flushWrites() }} onChange={value => {
            setSource(value); pending.current = value; clearTimeout(timer.current)
            timer.current = setTimeout(() => { void flushWrites().catch(cause => setError(String(cause))) }, 150)
          }} />}
      </section>
      <section className="right">
        <div className="preview" ref={previewRef} />
        {showTerminal && <div role="separator" tabIndex={0} aria-label="Resize preview and terminal panels"
          aria-orientation="horizontal" aria-valuemin={18} aria-valuemax={70} aria-valuenow={height}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.focus({ preventScroll: true }) }}
          onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault(); setHeight(value => Math.max(18, Math.min(70, value + (event.key === 'ArrowUp' ? 2 : -2))))
          } }} />}
        <div className="terminal" style={{ display: showTerminal ? 'block' : 'none', height: height + '%' }}>
          {ready && <NativeTerminal active={showTerminal} focusRef={focusRef} generation={0} theme="light"
            onCommand={onCommand} onListCommands={() => clientRef.current!.listTerminalCommands()}
            onListDirectory={path => clientRef.current!.listDirectory(path)} />}
        </div>
      </section>
    </div>
    <iframe ref={ownerRef} title="Native sandbox owner" allow="cross-origin-isolated" className="owner" />
  </main>
}

declare global {
  interface Window { reloadControl: { flushWrites(): Promise<void>; readEntry(): Promise<string>;
    inspections: { attempted: number; succeeded: number; failed: number } } }
}

createRoot(document.getElementById('root')!).render(<ReloadControl />)
