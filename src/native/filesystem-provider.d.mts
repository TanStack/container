import type {createNativeFilesystemClientApi} from './filesystem-client-api.mjs'
export type NativeFilesystemProvider=ReturnType<typeof createNativeFilesystemClientApi>
export declare function installNativeFilesystemProvider(provider:NativeFilesystemProvider,scope?:object):NativeFilesystemProvider
export declare function getNativeFilesystemProvider(scope?:object):NativeFilesystemProvider|undefined
