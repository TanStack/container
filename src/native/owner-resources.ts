/** Owner transport counts, not guest-wide Node handles or browser heap usage. */
export interface NativeOwnerResourceSnapshot {
  scope:'native-owner'
  running:boolean
  starting:boolean
  commands:number
  terminalSessions:number
  responseStreams:number
  sockets:number
  mutations:number
  installing:boolean
}
