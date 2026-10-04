import type {Volume,fs as memoryFilesystem} from 'memfs'
import type {glob,globSync} from 'node:fs'
import type {glob as promiseGlob} from 'node:fs/promises'

type NativeFilesystem=Omit<typeof memoryFilesystem,'glob'|'globSync'|'promises'> & {
  glob:typeof glob
  globSync:typeof globSync
  promises:Omit<typeof memoryFilesystem.promises,'glob'> & {glob:typeof promiseGlob}
}

export declare function createNativeFilesystemBackend(
  files?:Record<string,string|null>,cwd?:string,
):{fs:NativeFilesystem;vol:Volume}
