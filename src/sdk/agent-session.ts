import {WorkerKernel} from './worker-kernel'
import type {KernelOwnerOptions} from '../sandbox/kernel-limits'
import {AgentSessionCore,agentOutputLimit} from './agent-session-core'
import type {AgentSessionCoreOptions,AgentSessionBackend} from './agent-session-core'

export {AGENT_TOOL_DEFINITIONS} from './agent-session-core'
export type {AgentSessionBackend,AgentProcessHandle,AgentResourceSnapshot,AgentToolResult,AgentWorkspaceSnapshot,AgentWorkspaceBinarySnapshot,AgentSnapshotOptions} from './agent-session-core'
export interface AgentSessionOptions extends KernelOwnerOptions,AgentSessionCoreOptions {kernel?:AgentSessionBackend}

/** Legacy entry point, retaining its default WorkerKernel and files constructor. */
export class AgentSession extends AgentSessionCore {
  constructor(files:Record<string,string|Uint8Array>={},options:AgentSessionOptions={}){
    const {maxOutputBytes,kernel,telemetry,...kernelOptions}=options
    // Validate before creating a worker, including when no backend was provided.
    const limit=agentOutputLimit(maxOutputBytes)
    super(kernel??new WorkerKernel(files,kernelOptions),{maxOutputBytes:limit,telemetry})
  }
}
