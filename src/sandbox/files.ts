import type { VirtualFileSystem } from '../fs/types'

export type WorkspaceSnapshot = {version:1;files:Record<string,Uint8Array>} |
  {version:2;files:Record<string,Uint8Array>;directories:string[]} |
  {version:3;files:Record<string,Uint8Array>;directories:string[];symlinks:Record<string,string>} |
  {version:4;files:Record<string,Uint8Array>;directories:string[];symlinks:Record<string,string>;fileModes:Record<string,number>} |
  {version:5;files:Record<string,Uint8Array>;directories:string[];symlinks:Record<string,string>;fileModes:Record<string,number>;directoryModes:Record<string,number>}

export interface WorkspaceChange {path:string;eventType:'rename'|'change'}

interface Metadata {ino:number;nlink:number;atimeMs:number;mtimeMs:number;ctimeMs:number;birthtimeMs:number;permissions?:number}
export function fileCreationMode(value:unknown=0o666):number{
  value??=0o666
  if(typeof value==='string'&&/^[0-7]+$/.test(value))value=parseInt(value,8)
  if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>0o7777)throw Object.assign(new Error('EINVAL: invalid permission mode'),{code:'EINVAL'})
  // The virtual process profile currently has a fixed 022 creation mask.
  return value&~0o022
}
export interface WorkspaceStat extends Metadata {kind:'file'|'directory'|'symlink';size:number;mode:number;dev:number;uid:number;gid:number;rdev:number;blksize:number;blocks:number}
interface FileNode { bytes: Uint8Array; metadata:Metadata }

// Host-only references. A pathname can disappear or name a different file while
// an open reference continues to address the original file.
export interface WorkspaceFileReference {
  read(position:number,length:number):Uint8Array
  write(position:number,bytes:Uint8Array):number
  truncate(length:number):void
  stat():WorkspaceStat
  close():void
}

export function validateWorkspacePath(input: string): void {
  if (
    typeof input !== 'string' ||
    input.includes('\0') ||
    input.includes('\\')
  ) {
    throw new Error('EINVAL: expected a POSIX path')
  }
  if(input.length>4096||new TextEncoder().encode(input).byteLength>4096)
    throw new Error('ENAMETOOLONG: workspace paths are limited to 4096 UTF-8 bytes')
}
export function workspacePath(input: string): string {
  validateWorkspacePath(input)
  const parts: string[] = []
  for (const part of input.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) throw new Error('EACCES: path escapes workspace root')
      parts.pop()
    } else parts.push(part)
  }
  return '/' + parts.join('/')
}

export class WorkspaceFiles implements VirtualFileSystem {
  #files = new Map<string, FileNode>()
  #retained = new Map<FileNode, number>()
  // Count each node once for quotas, even when both a path and open handles
  // reference it. Unlinked nodes stay charged until their last handle closes.
  #nodeReferences = new Map<FileNode, number>()
  #byteLength = 0
  #directories = new Set<string>(['/'])
  #symlinks = new Map<string,string>()
  #metadata = new Map<string,Metadata>()
  #nextIno = 1
  #revision = 0
  #closed = false
  #listeners = new Set<(event:WorkspaceChange)=>void>()
  readonly maxBytes: number
  readonly maxFiles: number

  constructor(
    files: Record<string, string | Uint8Array> = {},
    maxBytes = 32 * 1024 * 1024,
    maxFiles = 16384,
  ) {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<0||!Number.isSafeInteger(maxFiles)||maxFiles<1)
      throw new Error('Invalid workspace limits')
    this.maxBytes = maxBytes
    this.maxFiles = maxFiles
    this.replace({
      version: 1,
      files: Object.fromEntries(
        Object.entries(files).map(([path, data]) => [
          path,
          typeof data === 'string' ? new TextEncoder().encode(data) : data,
        ]),
      ),
    })
  }

  get revision() {
    return this.#revision
  }
  get byteLength() {
    return this.#byteLength
  }
  get #fileCount() {
    return this.#nodeReferences.size
  }
  #retainNode(node:FileNode) {
    const count=this.#nodeReferences.get(node)??0
    if(!count)this.#byteLength+=node.bytes.length
    this.#nodeReferences.set(node,count+1)
  }
  #releaseNode(node:FileNode) {
    const count=this.#nodeReferences.get(node)
    if(count===undefined)return // Handles may be closed after the workspace.
    if(count>1)this.#nodeReferences.set(node,count-1)
    else {this.#nodeReferences.delete(node);this.#byteLength-=node.bytes.length}
  }
  #resizeNode(node:FileNode,bytes:Uint8Array) {
    this.#byteLength+=bytes.length-node.bytes.length
    node.bytes=bytes
  }
  #deleteEntry(path:string) {
    const node=this.#files.get(path)
    if(node){this.#files.delete(path);this.#releaseNode(node)}
    const target=this.#symlinks.get(path)
    if(target!==undefined){this.#symlinks.delete(path);this.#byteLength-=new TextEncoder().encode(target).length}
  }
  #check() {
    if (this.#closed) throw new Error('Workspace is closed')
  }
  close() {
    this.#closed = true
    for(const node of this.#retained.keys())node.bytes=new Uint8Array()
    this.#retained.clear()
    this.#nodeReferences.clear()
    this.#byteLength=0
    this.#files.clear()
    this.#directories.clear()
    this.#symlinks.clear()
    this.#metadata.clear()
    this.#listeners.clear()
  }

  subscribe(listener:(event:WorkspaceChange)=>void) {
    this.#check()
    this.#listeners.add(listener)
    return ()=>{this.#listeners.delete(listener)}
  }
  #notify(path:string,eventType:WorkspaceChange['eventType']) {
    const metadata=this.#metadata.get(path),now=Date.now()
    if(metadata){
      metadata.ctimeMs=now
      if(eventType==='change')metadata.mtimeMs=now
      if(!this.#files.has(path)&&!this.#directories.has(path)&&!this.#symlinks.has(path)){
        metadata.nlink=0;this.#metadata.delete(path)
      }
    }
    if(eventType==='rename'&&path!=='/'){
      const parent=this.#metadata.get(this.#parent(path))
      if(parent)parent.mtimeMs=parent.ctimeMs=now
    }
    const event=Object.freeze({path,eventType})
    for(const listener of [...this.#listeners])listener(event)
  }
  #newMetadata():Metadata{
    const now=Date.now()
    return {ino:this.#nextIno++,nlink:1,atimeMs:now,mtimeMs:now,ctimeMs:now,birthtimeMs:now}
  }
  #stat(kind:WorkspaceStat['kind'],size:number,metadata:Metadata):WorkspaceStat{
    const {permissions,...fields}=metadata
    return {...fields,kind,size,mode:kind==='file'?0o100000|(permissions??0o644):kind==='directory'?0o40000|(permissions??0o755):0o120777,
      dev:1,uid:0,gid:0,rdev:0,blksize:4096,blocks:Math.ceil(size/512)}
  }

  snapshot(): WorkspaceSnapshot {
    this.#check()
    return {
      version: 5,
      directoryModes:Object.fromEntries([...this.#directories].map(path=>[path,this.#metadata.get(path)?.permissions??0o755])),
      fileModes:Object.fromEntries([...this.#files].map(([path,node])=>[path,node.metadata.permissions??0o644])),
      directories: [...this.#directories].filter(path=>path!=='/').sort(),
      symlinks: Object.fromEntries(this.#symlinks),
      files: Object.fromEntries(
        [...this.#files].map(([path, node]) => [path, node.bytes.slice()]),
      ),
    }
  }

  replace(snapshot: WorkspaceSnapshot, expectedRevision = this.#revision) {
    this.#check()
    if (expectedRevision !== this.#revision)
      throw new Error('ECONFLICT: workspace changed during operation')
    if (
      !snapshot || ![1,2,3,4,5].includes(snapshot.version) ||
      !snapshot.files ||
      typeof snapshot.files !== 'object'
    )
      throw new Error('Invalid snapshot')
    const files = new Map<string, FileNode>()
    const directories = new Set<string>(['/'])
    const symlinks = new Map<string,string>()
    const addDirectory=(path:string)=>{
      for(const part of this.#parents(path+'/placeholder'))directories.add(part)
      if(directories.size-1>this.maxFiles)throw new Error('ENOSPC: workspace file-count quota exceeded (files and directories)')
    }
    if(snapshot.version!==1){
      if(!Array.isArray(snapshot.directories)||snapshot.directories.length>this.maxFiles)throw new Error('Invalid snapshot directories')
      for(const input of snapshot.directories)addDirectory(workspacePath(input))
    }
    let size = [...this.#retained.keys()].reduce((sum,node)=>sum+node.bytes.length,0)
    for (const [input, bytes] of Object.entries(snapshot.files)) {
      const path = workspacePath(input)
      if (path === '/' || files.has(path) || !(bytes instanceof Uint8Array))
        throw new Error('Invalid snapshot file')
      if(files.size>=this.maxFiles)throw new Error('ENOSPC: workspace file-count quota exceeded')
      size += bytes.length
      if (size > this.maxBytes)
        throw new Error('ENOSPC: workspace byte quota exceeded')
      files.set(path, {bytes:bytes.slice(),metadata:this.#newMetadata()})
      for(const parent of this.#parents(path))directories.add(parent)
      if(files.size+directories.size-1>this.maxFiles)throw new Error('ENOSPC: workspace file-count quota exceeded (files and directories)')
    }
    if(snapshot.version===3||snapshot.version===4||snapshot.version===5){
      if(!snapshot.symlinks||typeof snapshot.symlinks!=='object'||Array.isArray(snapshot.symlinks))throw new Error('Invalid snapshot symlinks')
      for(const [input,target] of Object.entries(snapshot.symlinks)){
        const path=workspacePath(input);validateWorkspacePath(target)
        if(!target||path==='/'||files.has(path)||symlinks.has(path))throw new Error('Invalid snapshot symlink')
        symlinks.set(path,target);size+=new TextEncoder().encode(target).length
        for(const parent of this.#parents(path))directories.add(parent)
        if(size>this.maxBytes)throw new Error('ENOSPC: workspace byte quota exceeded')
        if(files.size+symlinks.size+directories.size-1>this.maxFiles)throw new Error('ENOSPC: workspace file-count quota exceeded')
      }
    }
    if(snapshot.version===4||snapshot.version===5){
      if(!snapshot.fileModes||typeof snapshot.fileModes!=='object'||Array.isArray(snapshot.fileModes))throw new Error('Invalid snapshot file modes')
      if(Object.keys(snapshot.fileModes).length!==files.size)throw new Error('Incomplete snapshot file modes')
      for(const [path,mode] of Object.entries(snapshot.fileModes)){
        if(!files.has(path)||typeof mode!=='number'||!Number.isInteger(mode)||mode<0||mode>0o7777)throw new Error('Invalid snapshot file mode')
        files.get(path)!.metadata.permissions=mode
      }
    }
    if(snapshot.version===5){
      const modes=snapshot.directoryModes
      if(!modes||typeof modes!=='object'||Array.isArray(modes)||Object.keys(modes).length!==directories.size)throw new Error('Invalid snapshot directory modes')
      for(const [path,mode] of Object.entries(modes)){
        if(!directories.has(path)||typeof mode!=='number'||!Number.isInteger(mode)||mode<0||mode>0o7777)throw new Error('Invalid snapshot directory mode')
      }
    }
    for (const path of [...files.keys(),...symlinks.keys()]) {
      if(directories.has(path))throw new Error('ENOTDIR: file is also a directory')
      const parts = path.split('/')
      for (let i = 2; i < parts.length; i++) {
        if (files.has(parts.slice(0, i).join('/')))
          throw new Error('ENOTDIR: file is also a directory')
      }
    }
    if(size>this.maxBytes)throw new Error('ENOSPC: workspace byte quota exceeded')
    if(files.size+this.#retained.size+directories.size-1+symlinks.size>this.maxFiles)
      throw new Error('ENOSPC: workspace file-count quota exceeded')
    const previous=this.#files,previousDirectories=this.#directories,previousSymlinks=this.#symlinks,previousMetadata=this.#metadata
    for(const [path,node] of files){
      const before=previous.get(path)
      if(before&&before.bytes.length===node.bytes.length&&!before.bytes.some((byte,index)=>byte!==node.bytes[index])&&before.metadata.permissions===node.metadata.permissions)node.metadata=before.metadata
    }
    const metadata=new Map<string,Metadata>()
    for(const path of directories){
      const mode=snapshot.version===5?snapshot.directoryModes[path]:undefined
      const before=previousDirectories.has(path)?previousMetadata.get(path):undefined
      const next=before&&before.permissions===mode?before:this.#newMetadata()
      if(mode!==undefined)next.permissions=mode
      metadata.set(path,next)
    }
    for(const [path,target] of symlinks){
      const before=previousSymlinks.get(path)===target?previousMetadata.get(path):undefined
      metadata.set(path,before??this.#newMetadata())
    }
    for(const [path,node] of files)metadata.set(path,node.metadata)
    const now=Date.now()
    for(const [path,before] of previousMetadata)if(metadata.get(path)!==before){before.nlink=0;before.ctimeMs=now}
    this.#metadata=metadata
    this.#files = files
    this.#directories=directories
    this.#symlinks=symlinks
    this.#nodeReferences=new Map(this.#retained)
    for(const node of files.values())this.#nodeReferences.set(node,(this.#nodeReferences.get(node)??0)+1)
    this.#byteLength=size
    this.#revision++
    for(const path of previous.keys())if(!files.has(path))this.#notify(path,'rename')
    for(const path of previousDirectories)if(!directories.has(path))this.#notify(path,'rename')
    for(const path of directories)if(!previousDirectories.has(path))this.#notify(path,'rename')
    for(const path of new Set([...previousSymlinks.keys(),...symlinks.keys()]))if(previousSymlinks.get(path)!==symlinks.get(path))this.#notify(path,'rename')
    for(const [path,node] of files){
      const bytes=node.bytes,before=previous.get(path)?.bytes
      if(!before)this.#notify(path,'rename')
      else if(before.length!==bytes.length||before.some((byte,index)=>byte!==bytes[index])||previous.get(path)!.metadata.permissions!==node.metadata.permissions)this.#notify(path,'change')
    }
  }

  async exists(path: string) {
    return this.existsSync(path)
  }
  existsSync(path: string) {
    this.#check()
    try{this.#resolve(path);return true}catch(error){if(/^(ENOENT|ENOTDIR|ELOOP):/.test(String((error as Error).message)))return false;throw error}
  }
  entryExistsSync(path:string){try{this.#resolve(path,false);return true}catch(error){if(/^(ENOENT|ENOTDIR):/.test((error as Error).message))return false;throw error}}
  isFileSync(path:string){try{return this.#files.has(this.#resolve(path))}catch(error){if(/^(ENOENT|ENOTDIR):/.test((error as Error).message))return false;throw error}}
  isDirectorySync(path:string){try{return this.#directories.has(this.#resolve(path))}catch(error){if(/^(ENOENT|ENOTDIR):/.test((error as Error).message))return false;throw error}}
  #resolve(input:string,followFinal=true,missing:'leaf'|'directory'|'all'|false=false,rejectLinks=false):string {
    this.#check();validateWorkspacePath(input)
    const queue=input.split('/'),parts:string[]=[];let links=0
    const fail=(code:string)=>{throw Object.assign(new Error(code+': '+input),{code})}
    if(!input)fail('ENOENT')
    while(queue.length){
      const part=queue.shift()!
      if(!part||part==='.')continue
      if(part==='..'){if(!parts.length)fail('EACCES');parts.pop();continue}
      const path='/'+[...parts,part].join('/');validateWorkspacePath(path)
      if(rejectLinks&&this.#symlinks.has(path))fail('ELOOP')
      if(this.#symlinks.has(path)&&(followFinal||queue.length>0)){
        if(++links>40)fail('ELOOP')
        const target=this.#symlinks.get(path)!
        if(target.startsWith('/'))parts.length=0
        queue.unshift(...target.split('/'));continue
      }
      const exists=this.#files.has(path)||this.#directories.has(path)||this.#symlinks.has(path)
      if(!exists&&missing!=='all'&&!((missing==='leaf'||missing==='directory')&&!queue.length)&&!(missing==='directory'&&queue.every(part=>part==='')))fail('ENOENT')
      if(exists&&queue.length&&!this.#directories.has(path))fail('ENOTDIR')
      parts.push(part)
    }
    return '/'+parts.join('/')
  }
  realpathSync(path:string){return this.#resolve(path)}
  async realpath(path:string){return this.realpathSync(path)}
  async isFile(path:string){return this.isFileSync(path)}
  statSync(path:string,follow=true):WorkspaceStat{
    const key=this.#resolve(path,follow)
    const metadata=this.#metadata.get(key)!
    if(this.#symlinks.has(key))return this.#stat('symlink',new TextEncoder().encode(this.#symlinks.get(key)!).length,metadata)
    if(this.#directories.has(key))return {...this.#stat('directory',0,metadata),nlink:2+[...this.#directories].filter(path=>path!=='/'&&this.#parent(path)===key).length}
    return this.#stat('file',this.#files.get(key)!.bytes.length,metadata)
  }
  readlinkSync(path:string){const key=this.#resolve(path,false);if(!this.#symlinks.has(key))throw new Error('EINVAL: not a symbolic link: '+path);return this.#symlinks.get(key)!}
  symlinkSync(target:string,input:string){
    validateWorkspacePath(target);if(!target)throw new Error('ENOENT: empty symbolic link target')
    const path=this.#resolve(input,false,'leaf')
    if(this.entryExistsSync(path))throw new Error('EEXIST: '+path)
    if(this.#fileCount+this.#directories.size+this.#symlinks.size>this.maxFiles)throw new Error('ENOSPC: workspace file-count quota exceeded')
    const bytes=new TextEncoder().encode(target).length
    if(this.byteLength+bytes>this.maxBytes)throw new Error('ENOSPC: workspace byte quota exceeded')
    this.#symlinks.set(path,target);this.#byteLength+=bytes;this.#metadata.set(path,this.#newMetadata());this.#revision++;this.#notify(path,'rename')
  }
  #parents(path:string){const parts=path.split('/'),result=['/'];for(let i=2;i<parts.length;i++)result.push(parts.slice(0,i).join('/'));return result}
  #parent(path:string){return path.slice(0,path.lastIndexOf('/'))||'/'}
  #checkParents(path:string){for(const parent of this.#parents(path))if(this.#files.has(parent))throw new Error('ENOTDIR: parent is a file')}
  #requireParent(path:string){this.#checkParents(path);if(!this.#directories.has(this.#parent(path)))throw new Error('ENOENT: missing parent directory')}
  async list(prefix = '/') {
    return this.listSync(prefix)
  }
  listSync(prefix = '/') {
    this.#check()
    const path = workspacePath(prefix)
    return [...this.#files.keys()]
      .filter(
        (key) => path === '/' || key === path || key.startsWith(path + '/'),
      )
      .sort()
  }
  async readFile(path: string) {
    return this.readFileSync(path)
  }
  readFileSync(path: string) {
    this.#check()
    path=this.#resolve(path)
    if(this.#directories.has(path))throw new Error(`EISDIR: ${path}`)
    const file = this.#files.get(workspacePath(path))
    if (!file) throw new Error(`ENOENT: ${path}`)
    file.metadata.atimeMs=Date.now()
    return file.bytes.slice()
  }
  acquireFileSync(input:string):WorkspaceFileReference {
    const path=this.#resolve(input)
    if(this.#directories.has(path))throw new Error('EISDIR: '+input)
    let node=this.#files.get(path)!
    this.#retained.set(node,(this.#retained.get(node)??0)+1)
    this.#retainNode(node)
    let closed=false
    const check=()=>{
      if(closed)throw Object.assign(new Error('EBADF: file reference is closed'),{code:'EBADF'})
      this.#check()
    }
    const integer=(value:number)=>{
      if(!Number.isSafeInteger(value)||value<0)throw Object.assign(new Error('EINVAL: invalid file offset or length'),{code:'EINVAL'})
    }
    const update=(bytes:Uint8Array)=>{
      this.#resizeNode(node,bytes);node.metadata.mtimeMs=node.metadata.ctimeMs=Date.now();this.#revision++
      for(const [name,value] of this.#files)if(value===node)this.#notify(name,'change')
    }
    const allocation=(length:number)=>{
      if(this.byteLength-node.bytes.length+length>this.maxBytes)
        throw Object.assign(new Error('ENOSPC: workspace byte quota exceeded'),{code:'ENOSPC'})
    }
    return {
      read:(position,length)=>{
        check();integer(position);integer(length)
        const count=Math.min(length,Math.max(0,node.bytes.length-position))
        if(length)node.metadata.atimeMs=Date.now()
        return node.bytes.slice(position,position+count)
      },
      write:(position,bytes)=>{
        check();integer(position)
        if(!(bytes instanceof Uint8Array))throw new TypeError('Expected file bytes')
        if(!bytes.length)return 0
        const end=position+bytes.length;integer(end)
        const length=Math.max(node.bytes.length,end);allocation(length)
        const next=new Uint8Array(length);next.set(node.bytes);next.set(bytes,position)
        update(next);return bytes.length
      },
      truncate:(length)=>{
        check();integer(length);allocation(length)
        const next=new Uint8Array(length);next.set(node.bytes.subarray(0,length));update(next)
      },
      stat:()=>{check();return this.#stat('file',node.bytes.length,node.metadata)},
      close:()=>{
        if(closed)return
        closed=true
        const count=this.#retained.get(node)??0
        if(count<=1)this.#retained.delete(node);else this.#retained.set(node,count-1)
        this.#releaseNode(node)
        node={bytes:new Uint8Array(),metadata:node.metadata}
      },
    }
  }
  acquireDirectorySync(input:string):WorkspaceFileReference {
    const path=this.#resolve(input)
    if(!this.#directories.has(path))throw Object.assign(Error('ENOTDIR: '+input),{code:'ENOTDIR'})
    const metadata=this.#metadata.get(path)!
    let closed=false
    const check=()=>{this.#check();if(closed)throw Object.assign(Error('EBADF: directory reference is closed'),{code:'EBADF'})}
    const noBytes=():never=>{check();throw Object.assign(Error('EISDIR: cannot access directory as file bytes'),{code:'EISDIR'})}
    return {read:noBytes,write:noBytes,truncate:noBytes,
      stat:()=>{
        check()
        if(metadata.nlink){
          for(const [name,value] of this.#metadata)if(value===metadata)return this.statSync(name,false)
        }
        return this.#stat('directory',0,metadata)
      },
      close:()=>{closed=true},
    }
  }
  async readText(path: string) {
    return new TextDecoder().decode(await this.readFile(path))
  }
  async writeFile(input: string, bytes: Uint8Array,options?:{followSymlinks?:boolean;mode?:number}) {
    // Archive extraction checks every component before dot-dot processing,
    // including the final filename. Check and write without yielding.
    this.writeFileSync(input,bytes,true,options?.followSymlinks!==false,options?.mode)
  }
  writeFileSync(input: string, bytes: Uint8Array,createParents=true,followSymlinks=true,mode?:unknown) {
    this.#check()
    const permissions=fileCreationMode(mode)
    if (!(bytes instanceof Uint8Array))
      throw new Error('EINVAL: expected bytes')
    const path = this.#resolve(input,true,createParents?'all':'leaf',!followSymlinks)
    const parents=createParents?this.#parents(path).filter(parent=>!this.#directories.has(parent)):[]
    if(this.#fileCount+this.#symlinks.size+this.#directories.size-1+parents.length+(this.#files.has(path)?0:1)>this.maxFiles)
      throw new Error('ENOSPC: workspace file-count quota exceeded')
    if(this.#directories.has(path))throw new Error(`EISDIR: ${path}`)
    if(!createParents)this.#requireParent(path)
    const parts = path.split('/')
    for (let i = 2; i < parts.length; i++) {
      if (this.#files.has(parts.slice(0, i).join('/')))
        throw new Error('ENOTDIR: parent is a file')
    }
    // Every file's parents are in #directories, checked above. No descendant
    // scan is needed here, including after snapshot restore or directory rename.
    if (
      this.byteLength - (this.#files.get(path)?.bytes.length ?? 0) + bytes.length >
      this.maxBytes
    )
      throw new Error('ENOSPC: workspace byte quota exceeded')
    const existed=this.#files.has(path)
    const node=this.#files.get(path)
    if(node)this.#resizeNode(node,bytes.slice())
    else {const metadata={...this.#newMetadata(),permissions},created={bytes:bytes.slice(),metadata};this.#files.set(path,created);this.#retainNode(created);this.#metadata.set(path,metadata)}
    for(const parent of parents){this.#directories.add(parent);this.#metadata.set(parent,this.#newMetadata())}
    this.#revision++
    for(const parent of parents)this.#notify(parent,'rename')
    this.#notify(path,existed?'change':'rename')
  }
  async writeText(path: string, text: string) {
    await this.writeFile(path, new TextEncoder().encode(text))
  }
  chmodSync(input:string,mode:unknown){
    this.#check()
    if(typeof mode==='string'&&/^[0-7]+$/.test(mode))mode=parseInt(mode,8)
    if(typeof mode!=='number'||!Number.isInteger(mode)||mode<0||mode>0o7777)throw new Error('EINVAL: invalid permission mode')
    const path=this.#resolve(input)
    const metadata=this.#metadata.get(path)
    if(!metadata)throw new Error('ENOENT: '+path)
    metadata.permissions=mode;metadata.ctimeMs=Date.now();this.#revision++;this.#notify(path,'change')
  }
  async remove(path: string) {
    this.unlinkSync(path)
  }
  unlinkSync(input:string){
    this.#check();const path=this.#resolve(input,false)
    if(this.#directories.has(path))throw new Error(`EISDIR: ${path}`)
    if(!this.#files.has(path)&&!this.#symlinks.has(path))throw new Error(`ENOENT: ${path}`)
    this.#deleteEntry(path)
    this.#revision++
    this.#notify(path,'rename')
  }
  mkdirSync(input:string,recursive=false,mode:unknown=0o777):string|undefined{
    const permissions=fileCreationMode(mode??0o777)
    this.#check();const path=this.#resolve(input,false,recursive?'all':'directory');this.#checkParents(path)
    if(this.#symlinks.has(path)){if(recursive&&this.isDirectorySync(path))return;throw new Error('EEXIST: '+path)}
    if(this.#files.has(path))throw new Error(`EEXIST: ${path}`)
    if(this.#directories.has(path)){if(recursive)return;throw new Error(`EEXIST: ${path}`)}
    if(!recursive)this.#requireParent(path)
    const added=[...(recursive?this.#parents(path):[]),path].filter(part=>!this.#directories.has(part))
    if(this.#fileCount+this.#symlinks.size+this.#directories.size-1+added.length>this.maxFiles)throw new Error('ENOSPC: workspace file-count quota exceeded (files and directories)')
    for(const part of added){this.#directories.add(part);this.#metadata.set(part,{...this.#newMetadata(),permissions})}
    this.#revision++;for(const part of added)this.#notify(part,'rename')
    return recursive?added[0]:undefined
  }
  readdirSync(input:string,recursive=false):{name:string;parentPath:string;relativePath:string;kind:'file'|'directory'|'symlink'}[]{
    this.#check();const path=this.#resolve(input);this.#checkParents(path)
    if(this.#files.has(path))throw new Error(`ENOTDIR: ${path}`)
    if(!this.#directories.has(path))throw new Error(`ENOENT: ${path}`)
    const result:{name:string;parentPath:string;relativePath:string;kind:'file'|'directory'|'symlink'}[]=[],queue=[{physical:path,relative:''}]
    for(let i=0;i<queue.length;i++){
      const {physical:parent,relative}=queue[i],entries=[...this.#files.keys(),...this.#directories,...this.#symlinks.keys()].filter(key=>key!=='/'&&this.#parent(key)===parent).sort()
      for(const key of entries){
        const kind=this.#directories.has(key)?'directory':this.#symlinks.has(key)?'symlink':'file',name=key.slice(key.lastIndexOf('/')+1),relativePath=relative?relative+'/'+name:name
        result.push({name,parentPath:relative?workspacePath(input+'/'+relative):input,relativePath,kind})
        if(recursive&&kind==='directory')queue.push({physical:key,relative:relativePath})
      }
    }
    return result
  }
  rmdirSync(input:string){
    this.#check();const path=this.#resolve(input,false)
    if(path==='/')throw new Error('EBUSY: cannot remove workspace root')
    if(this.#symlinks.has(path))throw new Error('ENOTDIR: '+path)
    if(this.readdirSync(path).length)throw new Error(`ENOTEMPTY: ${path}`)
    this.#directories.delete(path);this.#revision++;this.#notify(path,'rename')
  }
  rmSync(input:string,{recursive=false,force=false}={}){
    this.#check();let path:string
    try{path=this.#resolve(input,false)}catch(error){if(force&&(error as Error).message.startsWith('ENOENT:'))return;throw error}
    if(path==='/')throw new Error('EBUSY: cannot remove workspace root')
    if(this.#files.has(path)||this.#symlinks.has(path)){this.unlinkSync(path);return}
    if(!this.#directories.has(path)){if(force)return;throw new Error(`ENOENT: ${path}`)}
    if(!recursive)throw new Error(`EISDIR: ${path}`)
    const entries=[...this.#files.keys(),...this.#directories,...this.#symlinks.keys()].filter(key=>key===path||key.startsWith(path+'/')).sort((a,b)=>b.length-a.length)
    for(const key of entries){this.#deleteEntry(key);this.#directories.delete(key)}
    this.#revision++;for(const key of entries)this.#notify(key,'rename')
  }
  renameSync(from:string,to:string){
    this.#check();from=this.#resolve(from,false)
    const directory=this.#directories.has(from)
    to=this.#resolve(to,false,directory?'directory':'leaf');this.#requireParent(to)
    if(from==='/'||to==='/')throw new Error('EBUSY: cannot rename workspace root')
    if(from===to)return
    if(directory&&to.startsWith(from+'/'))throw new Error('EINVAL: directory cannot contain itself')
    if(directory&&(this.#files.has(to)||this.#symlinks.has(to)))throw new Error('ENOTDIR: destination is a file')
    if(!directory&&this.#directories.has(to))throw new Error('EISDIR: destination is a directory')
    if(directory&&this.#directories.has(to)&&this.readdirSync(to).length)throw new Error('ENOTEMPTY: destination is not empty')
    const files=[...this.#files].filter(([path])=>path===from||path.startsWith(from+'/'))
    const directories=[...this.#directories].filter(path=>path===from||path.startsWith(from+'/'))
    const symlinks=[...this.#symlinks].filter(([path])=>path===from||path.startsWith(from+'/'))
    const targets=[...files.map(([path])=>path),...directories,...symlinks.map(([path])=>path)].map(path=>workspacePath(to+path.slice(from.length)))
    if(new Set(targets).size!==targets.length)throw new Error('EINVAL: duplicate rename destination')
    const metadata=[...this.#metadata].filter(([path])=>path===from||path.startsWith(from+'/'))
    const replaced=this.#metadata.get(to)
    if(replaced){replaced.nlink=0;replaced.ctimeMs=Date.now();this.#metadata.delete(to)}
    for(const [path] of metadata)this.#metadata.delete(path)
    for(const [path,value] of metadata)this.#metadata.set(to+path.slice(from.length),value)
    // Validate every destination before publishing any rename or watcher event.
    for(const [path] of files)this.#files.delete(path)
    for(const path of directories)this.#directories.delete(path)
    for(const [path] of symlinks)this.#symlinks.delete(path)
    this.#deleteEntry(to);this.#directories.delete(to)
    for(const [path,bytes] of files)this.#files.set(to+path.slice(from.length),bytes)
    for(const path of directories)this.#directories.add(to+path.slice(from.length))
    for(const [path,target] of symlinks)this.#symlinks.set(to+path.slice(from.length),target)
    this.#revision++;this.#notify(from,'rename');this.#notify(to,'rename')
  }
  async patch(path: string, before: string, after: string) {
    this.#check()
    const revision = this.#revision
    const text = await this.readText(path)
    const index = text.indexOf(before)
    if (
      !before ||
      index < 0 ||
      text.indexOf(before, index + before.length) >= 0
    )
      throw new Error('ECONFLICT: patch must match exactly once')
    if(revision!==this.#revision)throw new Error('ECONFLICT: workspace changed during operation')
    this.writeFileSync(path,new TextEncoder().encode(
      text.slice(0, index) + after + text.slice(index + before.length),
    ),false)
  }
}
