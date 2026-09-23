export interface StrictSplitAssets {
  directory: string
  previewHostDirectory: string
  evidence: {
    packaging: 'split'
    manifestSHA256: string
    runtimeManifestSHA256: string
    tarballSHA256: string
    runtimeTarballSHA256: string
    deploymentManifestSHA256: string
  }
  manifest: {buildProfile: string; engines?: unknown; files: {path: string; bytes: number; sha256: string}[]}
}
export function strictSDKFile(sdk: string, deployment: string | undefined, relative: string): string
export function prepareStrictSplitAssets(sdk: string, runtime: string | undefined): Promise<StrictSplitAssets | undefined>
