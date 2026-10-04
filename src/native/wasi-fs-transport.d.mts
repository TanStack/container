export declare function connectWasiFilesystemPort(port:MessagePort):()=>void
export declare function createWasiFilesystemClient(
  constructors:object,options:{decodeValue:(constructors:object,bytes:Uint8Array,type:number)=>unknown;
    send?:(message:unknown)=>void;wait?:typeof Atomics.wait;timeoutMs?:number},
):Record<string,(...args:any[])=>any>
export declare function createWasiFilesystemHost(
  fs:object,options:{getType:(value:unknown)=>number;encodeValue:(value:unknown,type:number)=>Uint8Array;onReply?:(row:any)=>void},
):((event:MessageEvent)=>void)&{dispose():void;inspect():{disposed:boolean;pendingBytes:number}}
export declare function manageWasiFilesystemWorker(worker:Worker,handler:ReturnType<typeof createWasiFilesystemHost>):void
export declare function traceWasiFilesystemReply(row:{encodedBytes:number;[key:string]:unknown}):void
