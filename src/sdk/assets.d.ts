/**
 * Node-only build helper. Copies the package's verified runtime assets into a
 * new destination directory and returns its canonical absolute path.
 * The parent directory must exist. Existing destinations are never overwritten.
 * A failed copy can leave partial output, which this helper does not delete.
 */
export declare function copyRuntimeAssets(destination: string): string

export interface PreviewHostRoute {
  readonly path: string
  readonly file: string
  readonly method: 'GET'
  readonly headers: Readonly<Record<string, string>>
}

export interface PreviewHostHostingContract {
  readonly separateOrigin: true
  readonly secureContext: true
  readonly scope: '/'
  readonly fallbackStatus: 503
  readonly embedderPolicy: 'require-corp'
  readonly documentResourcePolicy: 'cross-origin'
  readonly fallbackHeaders: Readonly<Record<string, string>>
  readonly routes: readonly PreviewHostRoute[]
}

/**
 * Node-only build helper. Copies the verified preview-host deployment tree,
 * including hosting.json, into a new destination directory.
 * The parent directory must exist. Existing destinations are never overwritten.
 */
export declare function copyPreviewHostAssets(destination: string): string

/** Read a fresh copy of the verified preview-host deployment contract. */
export declare function readPreviewHostHostingContract(): PreviewHostHostingContract

/** Create static owner files and their hosting headers for a separate origin. */
export declare function createNativeOwnerHostAssets(options: {
  runtimeCandidates?: ReadonlyArray<{workerURL: string; toolchain: {vite: string; rolldown: string}}>
  parentOrigin: string
  previewOrigin: string
  sdkPath?: string
  workerPath?: string
  assetBaseURL?: string
  /** Extra exact HTTPS origins for locked archives. Registry-only when omitted. */
  packageDownloadPolicy?: {additionalOrigins?: readonly string[]}
}): {
  files: Record<string, string>
  headers: Record<string, Record<string, string>>
}
