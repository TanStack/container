export interface VirtualFileSystem {
  exists(path: string): Promise<boolean>
  isFile?(path:string):Promise<boolean>
  realpath?(path:string):Promise<string>
  list(prefix?: string): Promise<string[]>
  readFile(path: string): Promise<Uint8Array>
  readText(path: string): Promise<string>
  // Filesystems with links must reject any linked path component when false.
  writeFile(path: string, contents: Uint8Array,options?:{followSymlinks?:boolean;mode?:number}): Promise<void>
  writeText(path: string, contents: string): Promise<void>
}

export interface FileSnapshot {
  [path: string]: string
}

export async function snapshotFileSystem(
  fs: VirtualFileSystem,
): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = {}
  for (const path of await fs.list()) snapshot[path] = await fs.readText(path)
  return snapshot
}
