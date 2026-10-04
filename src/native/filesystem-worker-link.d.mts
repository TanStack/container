export declare const FILESYSTEM_BOOTSTRAP:string
export declare const FILESYSTEM_ATTACH:string
export declare const FILESYSTEM_DETACH:string
export type NativeFilesystemConnection={control:{postMessage(message:unknown,transfer?:Transferable[]):void};id:string}
export declare function installNativeFilesystemConnection(connection:NativeFilesystemConnection,scope?:object):void
export declare function getNativeFilesystemConnection(scope?:object):NativeFilesystemConnection|undefined
export declare function linkNativeFilesystemWorker(worker:Pick<Worker,'postMessage'>,connection?:NativeFilesystemConnection):{id:string;dispose():void}|undefined
export declare function receiveNativeFilesystemBootstrap(target?:Pick<typeof globalThis,'addEventListener'|'removeEventListener'>,timeoutMs?:number):Promise<NativeFilesystemConnection & {type:string}>
