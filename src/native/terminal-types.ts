export type NativeTerminalOutput=(text:string,stream:'stdout'|'stderr')=>void
export interface NativeTerminalResult{
  cwd:string
  stdout:string
  stderr:string
  exitCode:number
  changedPaths:string[]
  /** True when the owner retained only the configured output byte budget. */
  truncated?:boolean
  /** Opaque shell variables to pass to the next command in this terminal session. */
  shellState?:string
}
