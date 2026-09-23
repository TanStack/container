import { compile } from '../sandbox/compile'
import { MemoryFileSystem } from '../fs/memory'
import { installLockedPackages } from '../npm/install'
import type { RuntimeLock } from '../npm/types'
import { loadBrowserViteEngine } from '../vite-browser/client'

interface SourceManifest {
  files: string[]
}

export interface StartBuildResult {
  code: string
  artifacts: Record<string, Uint8Array>
  outputFileCount: number
  packageCount: number
  viteDuration: number
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`Could not load ${url} (${response.status})`)
  return response.json() as Promise<T>
}

const builds = new Map<string,Promise<StartBuildResult>>()

export function buildStartFixtureInBrowser(
  onProgress?: (message: string) => void,
  target: 'browser' | 'workerd' = 'browser',
): Promise<StartBuildResult> {
  const existing=builds.get(target)
  if(existing)return existing
  const buildPromise = (async () => {
    onProgress?.('Loading Start source…')
    const [manifest, lock] = await Promise.all([
      fetchJson<SourceManifest>('/start-fixture/project-manifest.json'),
      fetchJson<RuntimeLock>('/start-fixture/browser-build-local-lock.json'),
    ])
    const fs = new MemoryFileSystem()
    await Promise.all(
      manifest.files.map(async (file) => {
        const response = await fetch(`/start-fixture/project/${file}`)
        if (!response.ok)
          throw new Error(
            `Could not load Start module '${file}' (${response.status})`,
          )
        await fs.writeFile(
          `/app/${file}`,
          new Uint8Array(await response.arrayBuffer()),
        )
      }),
    )

    onProgress?.(`Installing 0/${lock.packages.length} packages…`)
    await installLockedPackages(fs, lock, ({ completed, total }) => {
      onProgress?.(`Installing ${completed}/${total} packages…`)
    })

    onProgress?.('Running Start plugins in browser Vite…')
    const viteFiles: Record<string, Uint8Array> = {}
    for (const path of await fs.list()) {
      const vitePath = path.startsWith('/node_modules/') ? `/app${path}` : path
      viteFiles[vitePath] = await fs.readFile(path)
    }
    const viteResult = await (
      await loadBrowserViteEngine()
    ).runBrowserStartBuild(viteFiles)
    for (const [path, contents] of Object.entries(viteResult.files)) {
      await fs.writeFile(path, contents)
    }

    const serverEntry = '/app/dist/server/server.js'
    if (!(await fs.exists(serverEntry)))
      throw new Error('Browser Vite produced no Start server entry')
    onProgress?.('Bundling browser-generated Start server…')
    // This selects packages' edge-server exports, it does not run workerd.
    const files: Record<string,Uint8Array> = {}
    for(const path of await fs.list())files[path]=await fs.readFile(path)
    const result = await compile({version:1,files}, serverEntry, new AbortController().signal,
      target==='workerd'?{conditions:['workerd']}:{})
    return {
      code: result.code,
      artifacts: viteResult.files,
      outputFileCount: Object.keys(viteResult.files).length,
      packageCount: lock.packages.length,
      viteDuration: viteResult.duration,
    }
  })().catch((error) => {
    builds.delete(target)
    throw error
  })
  builds.set(target,buildPromise)
  return buildPromise
}
