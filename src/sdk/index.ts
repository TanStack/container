import {WorkerKernel as Kernel} from '../sandbox/kernel'
import type {KernelOwnerOptions} from '../sandbox/kernel-limits'

/** Versioned feature-detection contract for hosts embedding this experimental SDK. */
export const SDK_COMPATIBILITY={apiVersion:6,stability:'experimental'} as const

/** Experimental SDK. Host these trusted assets on the application's origin. */
export class WorkerKernel extends Kernel {
  constructor(files:Record<string,string|Uint8Array>={},options:KernelOwnerOptions={}){
    super(files,{...options,assetBaseURL:options.assetBaseURL??new URL('./runtime/',import.meta.url).href})
  }
}
export {HostedKernel} from './hosted-kernel'
export type {HostedKernelOptions,HostedPreviewOptions} from './hosted-kernel'
export type {HostCapabilities} from './host-protocol'
export {WorkerHTTP} from '../sandbox/worker-http'
export {WorkerWebSocket} from '../sandbox/worker-websocket'
export {URLPreview} from '../sandbox/url-preview'
export {runMvdanShell} from '../sandbox/mvdan-shell'
export {runShell} from './shell'
export {installProjectCommand,spawnProjectCommand} from './project-command'
export type {InstallProjectCommandOptions,SpawnProjectCommandOptions,ProjectCommandKernel} from './project-command'
export {AgentSession,AGENT_TOOL_DEFINITIONS} from './agent-session'
export type {AgentSessionOptions,AgentToolResult,AgentWorkspaceSnapshot,AgentWorkspaceBinarySnapshot,AgentSnapshotOptions} from './agent-session'
export {SandboxTelemetry} from './telemetry'
export type {SandboxTelemetryEvent,SandboxTelemetryOptions} from './telemetry'
export {resolveSDKRuntimeProfile,assertSDKRuntimeEnvironment} from './runtime-profile'
export type {SDKRuntimeWorkload,SDKRuntimeKernelOptions,SDKRuntimeProfile,SDKRuntimeEnvironment} from './runtime-profile'
export type {KernelOptions,KernelExecutionResult,KernelProcessResult,KernelProcessHandle,KernelResourceSnapshot} from '../sandbox/kernel'
export type {KernelOwnerOptions,KernelLimits,KernelWorkspaceLimits} from '../sandbox/kernel-limits'
export type {WorkspaceSnapshot} from '../sandbox/files'
export type {CheckpointMetadata} from '../sandbox/checkpoint-storage'
export type {SpawnOptions,ProcessEvent} from '../sandbox/guest-processes'
export type {PortEvent} from '../sandbox/virtual-network'
export type {ProjectInstallOptions,ProjectInstallResult} from '../npm/project'
export type {ShellOptions,ShellResult} from '../sandbox/mvdan-shell'
export type {ShellExecutionOptions,ShellExecutionResult} from './shell'
