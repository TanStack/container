export interface BrowserViteBuildOutput {
  duration: number
  files: Record<string, Uint8Array>
}

export interface BrowserViteEngine {
  runBrowserStartBuild: (
    files: Record<string, string | Uint8Array>,
  ) => Promise<BrowserViteBuildOutput>
  runBrowserViteSmokeBuild: (
    files: Record<string, string | Uint8Array>,
  ) => Promise<BrowserViteBuildOutput>
}

// Each build owns its worker, globals, and memfs volume.
// The trusted, pinned toolchain is separate from opaque guest execution.
export async function loadBrowserViteEngine(): Promise<BrowserViteEngine> {
  const run = (method: keyof BrowserViteEngine, files: Record<string, string | Uint8Array>): Promise<BrowserViteBuildOutput> => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('/vite-runtime/engine.js', location.href), { type: 'module' })
    let finished=false
    const finish = (error?: Error, result?: BrowserViteBuildOutput) => {
      if(finished)return
      finished=true
      clearTimeout(timer)
      worker.terminate()
      error ? reject(error) : resolve(result!)
    }
    const timer = setTimeout(() => finish(new Error('Vite build timed out')), 90_000)
    worker.onerror = event => finish(new Error(event.message))
    worker.onmessage = event => {
      if(finished)return
      if (event.data.type === 'ready') worker.postMessage({ method, files })
      else finish(event.data.error ? new Error(event.data.error) : undefined, event.data.result)
    }
  })
  return {
    runBrowserStartBuild: files => run('runBrowserStartBuild', files),
    runBrowserViteSmokeBuild: files => run('runBrowserViteSmokeBuild', files),
  }
}
