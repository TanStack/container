export type FilesystemMessageHandler=((event:MessageEvent)=>void)&{dispose():void}
export type FilesystemService={
  onMessage(event:MessageEvent|{data:any}):void
  release(id:string):void
  releaseScope(prefix:string):void
  inspect():{disposed:boolean;clients:number;descriptors:number}
  inspectWatchers():{watches:number;pendingEvents:number;inFlightEvents:number}
  inspectDirectories():{directories:number}
  dispose():void
}
export declare function createWasiFilesystemService(
  fs:object,handler:((fs:object)=>FilesystemMessageHandler)|Record<string,(fs:object)=>FilesystemMessageHandler>,
  options?:{maxPendingWatchEvents?:number},
):FilesystemService
export declare function createWasiFilesystemEndpoint(
  control:{postMessage(message:unknown,transfer?:Transferable[]):void},id:string,options?:{codec?:string},
):{port:MessagePort;dispose():void}
