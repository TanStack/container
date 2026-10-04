export interface PreparedRuntimeAssets {
  directory: string
  runtimeDirectory: string
  previewHostDirectory: string
  kernelHostPath?: string
  nativeWorkerPath?: string
  manifestPath: string
}
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
/** Assemble installed dependencies into a new hosting directory. Never overwrites. */
export declare function prepareRuntimeAssets(destination: string): Promise<PreparedRuntimeAssets>
/** Hosting headers and routes required by the separate preview origin. */
export declare function readPreviewHostHostingContract(): PreviewHostHostingContract
/** Verified configuration and compiler catalog for the installed runtime profile. */
export declare function readRuntimeProfileManifest(): Record<string, unknown>

/** Read versioned worker paths and exact compiler versions from the installed runtime package. */
export declare function readNativeRuntimeCandidates(runtimePath?: string): Array<{
  workerURL: string
  toolchain: {vite: string; rolldown: string}
}>
/** Create static owner files and their hosting headers for a separate origin. */
export declare function createNativeOwnerHostAssets(options: {
  runtimeCandidates?: ReadonlyArray<{workerURL: string; toolchain: {vite: string; rolldown: string}}>
  parentOrigin: string
  previewOrigin: string
  previewHostSuffix?: string
  /** Configured connection identity, not an artifact attestation. */
  buildId?: string
  sdkPath?: string
  workerPath?: string
  assetBaseURL?: string
}): {
  files: Record<string, string>
  headers: Record<string, Record<string, string>>
}
