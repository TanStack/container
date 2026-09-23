export interface NodeAPISurfaceReport {
  schemaVersion: number
  nativeRuntime: string
  runtimeArtifactVersion: number
  runtimeArtifactSHA256: string
  warning: string
  nativePublicModuleCount: number
  supportedModuleCount: number
  missingPublicModules: string[]
  modules: Array<{module: string; present: string[]; missing: string[]; extra: string[]}>
}
export function generateNodeAPISurface(): Promise<NodeAPISurfaceReport>
export function renderNodeAPISurface(report: NodeAPISurfaceReport): string
export function writeNodeAPISurface(): Promise<NodeAPISurfaceReport>
