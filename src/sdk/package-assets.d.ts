export interface PreparedRuntimeAssets {
  directory: string
  runtimeDirectory: string
  previewHostDirectory: string
  kernelHostPath: string
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
/** Verified runtime configuration accepted by resolveSDKRuntimeProfile. */
export declare function readRuntimeProfileManifest(): Record<string, unknown>
