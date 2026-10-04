import type {Volume} from 'memfs'

/** Public file operations used by installers and terminal sessions. */
export const nativeFileOperationNames=[
  'accessSync','existsSync','statSync','lstatSync','fstatSync','realpathSync','readlinkSync',
  'readdirSync','readFileSync','writeFileSync','mkdirSync','symlinkSync','chmodSync',
  'fchmodSync','utimesSync','futimesSync','truncateSync','ftruncateSync','unlinkSync',
  'renameSync','copyFileSync','cpSync','rmSync','rmdirSync','openSync','closeSync',
  'readSync','writeSync','fsyncSync','fdatasyncSync',
] as const

export type NativeFileOperations=Pick<Volume,typeof nativeFileOperationNames[number]> & {
  writeFileWithParentsSync?:(path:string,contents:Uint8Array,options?:{followSymlinks?:boolean;mode?:number})=>void
}
