import { WorkspaceFiles, type WorkspaceSnapshot } from './files'
import { compile } from './compile'
import {
  GuestProcess,
  type ExecutionResult,
  type ProcessOptions,
} from './process'
import { checkpoint } from './persistence'
import { installLockedPackages } from '../npm/install'
import type { RuntimeLock, InstallProgress } from '../npm/types'
import { executeVM, type VMExecutionOptions } from './vm-execution'

export class Workspace {
  readonly files: WorkspaceFiles
  #processes = new Set<GuestProcess>()
  #controller = new AbortController()

  constructor(
    options: {
      files?: Record<string, string | Uint8Array>
      maxBytes?: number
    } = {},
  ) {
    this.files = new WorkspaceFiles(options.files, options.maxBytes)
  }

  async bundle(entry: string) {
    return compile(this.files.snapshot(), entry, this.#controller.signal)
  }

  async execute(
    entry: string,
    options: ProcessOptions = {},
  ): Promise<ExecutionResult> {
    const started = performance.now()
    const process = new GuestProcess(this.files, {
      ...options,
      argv: ['browser-js', entry, ...(options.argv ?? [])],
    })
    this.#processes.add(process)
    try {
      const result = await this.bundle(entry)
      await process.load(result.code)
      return {
        exitCode: 0,
        stdout: process.stdout,
        stderr: process.stderr,
        duration: performance.now() - started,
      }
    } catch (error) {
      return {
        exitCode: 1,
        stdout: process.stdout,
        stderr: process.stderr + String(error),
        duration: performance.now() - started,
      }
    } finally {
      process.close()
      this.#processes.delete(process)
    }
  }

  async executeInVM(
    entry: string,
    options: VMExecutionOptions = {},
  ): Promise<ExecutionResult> {
    const started = performance.now()
    try {
      const result = await this.bundle(entry)
      return await executeVM(result.code, this.files, this.#controller.signal, {
        ...options,
        argv: ['quickjs', entry, ...(options.argv ?? [])],
      })
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: String(error),
        duration: performance.now() - started,
      }
    }
  }

  async serve(
    entry: string,
    options: ProcessOptions = {},
  ): Promise<GuestProcess> {
    const result = await this.bundle(entry)
    return this.serveCode(result.code, options)
  }

  async serveCode(
    code: string,
    options: ProcessOptions = {},
  ): Promise<GuestProcess> {
    if (this.#controller.signal.aborted) throw new Error('Workspace closed')
    const process = new GuestProcess(this.files, options)
    this.#processes.add(process)
    try {
      if (!(await process.load(code)))
        throw new Error('Module does not export a fetch handler')
      return process
    } catch (error) {
      process.close()
      this.#processes.delete(process)
      throw error
    }
  }

  async install(
    lock: RuntimeLock,
    onProgress?: (progress: InstallProgress) => void,
  ) {
    // Stage all packages before committing, so a bad archive cannot half-install a workspace.
    const revision = this.files.revision
    const staged = new WorkspaceFiles(
      {},
      this.files.maxBytes,
      this.files.maxFiles,
    )
    staged.replace(this.files.snapshot())
    for (const pkg of lock.packages) {
      const url = new URL(pkg.resolved)
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'registry.npmjs.org' ||
        url.port ||
        url.username ||
        url.password
      ) {
        throw new Error(
          'Package downloads are restricted to https://registry.npmjs.org',
        )
      }
      if (
        !/^\/node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(
          pkg.installPath,
        ) ||
        pkg.installPath.split('/').some((part) => part === '..' || part === '.')
      ) {
        throw new Error('Invalid package install path')
      }
    }
    await installLockedPackages(
      staged,
      lock,
      onProgress,
      this.#controller.signal,
    )
    this.files.replace(staged.snapshot(), revision)
  }

  snapshot() {
    return this.files.snapshot()
  }
  async save(key: string) {
    await checkpoint('save', key, this.snapshot())
  }
  static restore(snapshot: WorkspaceSnapshot) {
    const workspace = new Workspace()
    workspace.files.replace(snapshot)
    return workspace
  }
  static async open(key: string) {
    const snapshot = await checkpoint('load', key)
    if (!snapshot) throw new Error(`No checkpoint: ${key}`)
    return Workspace.restore(snapshot)
  }
  close() {
    this.#controller.abort()
    for (const process of this.#processes) process.close('Workspace closed')
    this.#processes.clear()
    this.files.close()
  }
}
